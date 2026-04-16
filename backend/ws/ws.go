package ws

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/matthias-p-nowak/nemo-lab/annotations"
	"github.com/matthias-p-nowak/nemo-lab/auth"
	"github.com/matthias-p-nowak/nemo-lab/logger"
	"github.com/matthias-p-nowak/nemo-lab/tiles"
	"golang.org/x/net/websocket"
)

type connState struct {
	count                int
	activeTaskID         string
	hashToPath           map[string]string
	prefetchSeq          uint64
	annotationsDir       string
	singleFile           bool
	activeAnnotationPath string
	activeAnnotationHash string
}

type fileAnnotations struct {
	af           *annotations.AnnotationFile
	dirty        bool
	timer        *time.Timer
	hashCheckCtx *pendingHashCheck
}

type pendingHashCheck struct {
	token     string
	hash      string
	imagePath string
}

var (
	connectionsMu     sync.Mutex
	connections       = map[string]*connState{}
	annotationStoreMu sync.Mutex
	annotationStore   = map[string]*fileAnnotations{}
	liveConnsMu       sync.Mutex
	liveConns         = map[*websocket.Conn]struct {
		token   string
		writeMu *sync.Mutex
	}{}
)

// NewHandler builds the /ws handler and validates session cookies before upgrade.
func NewHandler(db *sql.DB, logsDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("nemo_session")
		if err != nil || !auth.ValidSessionToken(cookie.Value) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		websocket.Handler(func(conn *websocket.Conn) {
			defer conn.Close()
			writeMu := &sync.Mutex{}

			lgr, loggerErr := logger.New(logsDir, time.Now())
			if loggerErr != nil {
				log.Printf("ws logger init failed: %v", loggerErr)
				lgr = nil
			}
			if lgr != nil {
				_ = lgr.Append(map[string]any{
					"type":         "connect",
					"ts":           time.Now().Format(time.RFC3339),
					"token_prefix": tokenPrefix(cookie.Value),
				})
			}

			connectionsMu.Lock()
			if connections[cookie.Value] == nil {
				connections[cookie.Value] = &connState{
					hashToPath: make(map[string]string),
				}
			}
			connections[cookie.Value].count++
			active := connections[cookie.Value].count
			connectionsMu.Unlock()
			registerLiveConn(cookie.Value, conn, writeMu)
			log.Printf("ws connect token=%s active=%d", cookie.Value, active)

			defer func() {
				flushActiveAnnotationOnDisconnect(cookie.Value, lgr)
				unregisterLiveConn(conn)
				connectionsMu.Lock()
				if s := connections[cookie.Value]; s != nil && s.count > 1 {
					s.count--
				} else {
					delete(connections, cookie.Value)
				}
				remaining := 0
				if s := connections[cookie.Value]; s != nil {
					remaining = s.count
				}
				connectionsMu.Unlock()
				log.Printf("ws disconnect token=%s active=%d", cookie.Value, remaining)

				if lgr != nil {
					_ = lgr.Append(map[string]any{
						"type": "disconnect",
						"ts":   time.Now().Format(time.RFC3339),
					})
					_ = lgr.Close()
				}
			}()

			for {
				var msg map[string]any
				if err := websocket.JSON.Receive(conn, &msg); err != nil {
					break
				}

				msgType, _ := msg["type"].(string)
				entry := payloadMap(msg)

				switch msgType {
				case "log":
					if lgr != nil {
						_ = lgr.Append(entry)
					}
					if eventType, _ := entry["type"].(string); eventType == "set_active_task" {
						taskID, _ := entry["task_id"].(string)
						handleSetActiveTask(db, cookie.Value, conn, writeMu, lgr, taskID)
					}
				case "set_active_task":
					taskID, _ := entry["task_id"].(string)
					if lgr != nil {
						_ = lgr.Append(entry)
					}
					handleSetActiveTask(db, cookie.Value, conn, writeMu, lgr, taskID)
				case "prefetch":
					hashes := prefetchHashes(msg, entry)
					seq := nextPrefetchSeq(cookie.Value)
					go handlePrefetch(cookie.Value, conn, writeMu, lgr, hashes, seq)
				case "find_first_annotated_image":
					hashes := prefetchHashes(msg, entry)
					currentHash, _ := msg["current_hash"].(string)
					if currentHash == "" {
						currentHash, _ = entry["current_hash"].(string)
					}
					handleFindFirstAnnotatedImage(cookie.Value, conn, writeMu, hashes, currentHash)
				case "load_annotations":
					hash, _ := msg["hash"].(string)
					if hash == "" {
						hash, _ = entry["hash"].(string)
					}
					if hash == "" {
						continue
					}
					handleLoadAnnotations(cookie.Value, conn, writeMu, lgr, hash)
				case "save_annotations":
					hash, _ := msg["hash"].(string)
					if hash == "" {
						hash, _ = entry["hash"].(string)
					}
					if hash == "" {
						continue
					}
					payload := msg["annotations"]
					if payload == nil {
						payload = entry["annotations"]
					}
					handleSaveAnnotations(db, cookie.Value, conn, lgr, hash, payload)
				default:
					if msgType == "" {
						continue
					}
				}
			}
		}).ServeHTTP(w, r)
	}
}

func handleFindFirstAnnotatedImage(token string, conn *websocket.Conn, writeMu *sync.Mutex, hashes []string, currentHash string) {
	hash := firstUnannotatedHashOnDisk(token, hashes, currentHash)
	if hash == "" {
		return
	}
	_ = wsSendJSON(conn, writeMu, map[string]any{
		"type": "first_annotated_image",
		"hash": hash,
	})
}

func firstUnannotatedHashOnDisk(token string, hashes []string, currentHash string) string {
	if len(hashes) == 0 {
		return ""
	}

	startIndex := 0
	if currentHash != "" {
		for i, hash := range hashes {
			if hash != currentHash {
				continue
			}
			startIndex = i + 1
			break
		}
	}
	if startIndex >= len(hashes) {
		return ""
	}

	pathIsUnannotated := map[string]bool{}
	pathChecked := map[string]bool{}
	for _, hash := range hashes[startIndex:] {
		ctx, ok := loadAnnotationContext(token, hash)
		if !ok {
			continue
		}
		path := annotationFilePath(ctx.annotationsDir, ctx.singleFile, ctx.imagePath)
		if pathChecked[path] {
			if pathIsUnannotated[path] {
				return hash
			}
			continue
		}
		pathChecked[path] = true
		af, err := annotations.ReadAnnotations(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				pathIsUnannotated[path] = true
				return hash
			}
			log.Printf("ws find_first_annotated_image read failed token=%s hash=%.16s path=%s err=%v", tokenPrefix(token), hash, path, err)
			pathIsUnannotated[path] = false
			continue
		}
		pathIsUnannotated[path] = len(af.Annotations) == 0
		if pathIsUnannotated[path] {
			return hash
		}
	}
	return ""
}

func handleSetActiveTask(
	db *sql.DB,
	token string,
	conn *websocket.Conn,
	writeMu *sync.Mutex,
	lgr *logger.Logger,
	taskID string,
) {
	annotationsDir, singleFile, cfgErr := taskAnnotationsConfig(db, taskID)
	if cfgErr != nil {
		log.Printf("ws set_active_task annotations config lookup failed: task_id=%s err=%v", taskID, cfgErr)
		annotationsDir = ""
		singleFile = false
	}
	resetTaskAnnotationState(token, taskID, annotationsDir, singleFile)

	imagesRoot, err := taskImagesPath(db, taskID)
	if err != nil {
		log.Printf("ws set_active_task task lookup failed: task_id=%s err=%v", taskID, err)
		storeHashMap(token, map[string]string{})
		_ = wsSendJSON(conn, writeMu, map[string]any{"type": "image_list", "images": []imageItem{}})
		return
	}
	items, hashToPath, err := listTaskImages(imagesRoot)
	if err != nil {
		log.Printf("ws set_active_task scan failed: task_id=%s root=%s err=%v", taskID, imagesRoot, err)
		storeHashMap(token, map[string]string{})
		_ = wsSendJSON(conn, writeMu, map[string]any{"type": "image_list", "images": []imageItem{}})
		return
	}
	storeHashMap(token, hashToPath)
	logAppend(lgr, map[string]any{
		"type":        "image_list",
		"ts":          time.Now().Format(time.RFC3339),
		"image_count": len(items),
	})
	_ = wsSendJSON(conn, writeMu, map[string]any{"type": "image_list", "images": items})
}

func handlePrefetch(
	token string,
	conn *websocket.Conn,
	writeMu *sync.Mutex,
	lgr *logger.Logger,
	hashes []string,
	seq uint64,
) {
	if len(hashes) == 0 {
		return
	}
	// If a newer prefetch already exists, drop this one before doing any work.
	if !isCurrentPrefetchSeq(token, seq) {
		return
	}
	log.Printf("ws prefetch token=%s hashes=%d", tokenPrefix(token), len(hashes))
	logAppend(lgr, map[string]any{
		"type":   "prefetch",
		"ts":     time.Now().Format(time.RFC3339),
		"hashes": len(hashes),
	})
	hashToPath := loadHashMap(token)

	firstHash := hashes[0]
	if absPath, ok := hashToPath[firstHash]; ok {
		readySent := false
		_, err := tiles.GenerateByPathWithProgressAndEvents(
			absPath,
			func(level, totalLevels int) {
				if !isCurrentPrefetchSeq(token, seq) {
					return
				}
				readySent = true
				log.Printf("ws image_ready token=%s hash=%.16s level=%d/%d", tokenPrefix(token), firstHash, level, totalLevels-1)
				_ = wsSendJSON(conn, writeMu, map[string]any{
					"type":         "image_ready",
					"hash":         firstHash,
					"level":        level,
					"total_levels": totalLevels,
				})
			},
			func(entry map[string]any) {
				entry["ts"] = time.Now().Format(time.RFC3339)
				logAppend(lgr, entry)
			},
		)
		if err != nil {
			log.Printf("ws prefetch tile generation failed token=%s hash=%.16s err=%v", tokenPrefix(token), firstHash, err)
			logAppend(lgr, map[string]any{
				"type":  "prefetch_error",
				"ts":    time.Now().Format(time.RFC3339),
				"hash":  firstHash,
				"error": err.Error(),
			})
		} else if !readySent && isCurrentPrefetchSeq(token, seq) {
			totalLevels, levelsErr := readManifestLevels(firstHash)
			if levelsErr != nil || totalLevels < 1 {
				totalLevels = 1
			}
			level := totalLevels - 1
			log.Printf("ws image_ready cache-hit token=%s hash=%.16s level=%d/%d", tokenPrefix(token), firstHash, level, totalLevels-1)
			_ = wsSendJSON(conn, writeMu, map[string]any{
				"type":         "image_ready",
				"hash":         firstHash,
				"level":        level,
				"total_levels": totalLevels,
			})
		}
	} else {
		log.Printf("ws prefetch first hash not in session map token=%s hash=%.16s", tokenPrefix(token), firstHash)
		logAppend(lgr, map[string]any{
			"type":  "prefetch_error",
			"ts":    time.Now().Format(time.RFC3339),
			"hash":  firstHash,
			"error": "hash not in session map",
		})
	}

	// Do not warm trailing hashes for superseded requests.
	if !isCurrentPrefetchSeq(token, seq) {
		return
	}
	for _, hash := range hashes[1:] {
		absPath, ok := hashToPath[hash]
		if !ok {
			continue
		}
		go func(path string) {
			_, _ = tiles.EnsureGeneratedByPath(path)
		}(absPath)
	}
}

func handleLoadAnnotations(
	token string,
	conn *websocket.Conn,
	writeMu *sync.Mutex,
	lgr *logger.Logger,
	hash string,
) {
	ctx, ok := loadAnnotationContext(token, hash)
	if !ok {
		sendAnnotationsData(conn, writeMu, hash, emptyAnnotationFile())
		return
	}
	path := annotationFilePath(ctx.annotationsDir, ctx.singleFile, ctx.imagePath)
	if err := migrateAnnotationFileIfNeeded(token, path, ctx.annotationsDir, ctx.singleFile, ctx.imagePath); err != nil {
		log.Printf("ws load_annotations migration failed token=%s hash=%.16s path=%s err=%v", tokenPrefix(token), hash, path, err)
	}
	setActiveAnnotationPath(token, path, hash)
	af := getOrLoadSharedAnnotations(path, token, hash, lgr)
	sendAnnotationsData(conn, writeMu, hash, af)
}

func handleSaveAnnotations(db *sql.DB, token string, conn *websocket.Conn, lgr *logger.Logger, hash string, payload any) {
	if payload == nil {
		return
	}
	ctx, ok := loadAnnotationContext(token, hash)
	if !ok {
		return
	}
	path := annotationFilePath(ctx.annotationsDir, ctx.singleFile, ctx.imagePath)
	setActiveAnnotationPath(token, path, hash)

	raw, err := json.Marshal(payload)
	if err != nil {
		log.Printf("ws save_annotations marshal failed token=%s hash=%.16s err=%v", tokenPrefix(token), hash, err)
		return
	}
	var af annotations.AnnotationFile
	if err := json.Unmarshal(raw, &af); err != nil {
		log.Printf("ws save_annotations decode failed token=%s hash=%.16s err=%v", tokenPrefix(token), hash, err)
		return
	}
	if af.Images == nil {
		af.Images = []annotations.CocoImage{}
	}
	if af.Annotations == nil {
		af.Annotations = []annotations.CocoAnnotation{}
	}
	if af.Categories == nil {
		af.Categories = []annotations.CocoCategory{}
	}
	existing := getOrLoadSharedAnnotations(path, token, hash, lgr)
	username, _ := auth.UsernameFromSessionToken(db, token)
	applyCommentAuthorUpdate(existing, &af, username)
	merged := mergeAndStoreSharedAnnotations(path, &af, ctx.imagePath, hash, token, lgr)
	broadcastAnnotationsData(path, hash, merged, conn)
}

func applyCommentAuthorUpdate(existing, incoming *annotations.AnnotationFile, username string) {
	if incoming == nil {
		return
	}

	prevComments := decodeStringMap(existing.NemolabComments)
	nextComments := decodeStringMap(incoming.NemolabComments)
	prevAuthors := decodeStringMap(existing.NemolabAuthors)
	nextAuthors := decodeStringMap(incoming.NemolabAuthors)

	for key, value := range prevAuthors {
		if _, ok := nextAuthors[key]; ok {
			continue
		}
		nextAuthors[key] = value
	}

	keys := map[string]struct{}{}
	for key := range prevComments {
		keys[key] = struct{}{}
	}
	for key := range nextComments {
		keys[key] = struct{}{}
	}

	for key := range keys {
		prevValue := prevComments[key]
		nextValue := nextComments[key]
		if prevValue == nextValue {
			continue
		}
		if nextValue == "" {
			delete(nextAuthors, key)
			continue
		}
		if username != "" {
			nextAuthors[key] = username
		}
	}

	for key := range nextAuthors {
		if nextComments[key] != "" {
			continue
		}
		delete(nextAuthors, key)
	}

	incoming.NemolabComments = encodeStringMap(nextComments)
	incoming.NemolabAuthors = encodeStringMap(nextAuthors)
}

func decodeStringMap(raw json.RawMessage) map[string]string {
	out := map[string]string{}
	if len(raw) == 0 {
		return out
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return out
	}
	for key, value := range parsed {
		text, ok := value.(string)
		if !ok || text == "" {
			continue
		}
		out[key] = text
	}
	return out
}

func encodeStringMap(values map[string]string) json.RawMessage {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]string, len(values))
	for key, value := range values {
		if value == "" {
			continue
		}
		out[key] = value
	}
	if len(out) == 0 {
		return nil
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return json.RawMessage(raw)
}

type annotationContext struct {
	annotationsDir string
	singleFile     bool
	imagePath      string
}

func loadAnnotationContext(token, hash string) (annotationContext, bool) {
	connectionsMu.Lock()
	defer connectionsMu.Unlock()
	s := connections[token]
	if s == nil {
		return annotationContext{}, false
	}
	imagePath, ok := s.hashToPath[hash]
	if !ok {
		return annotationContext{}, false
	}
	return annotationContext{
		annotationsDir: s.annotationsDir,
		singleFile:     s.singleFile,
		imagePath:      imagePath,
	}, true
}

func sendAnnotationsData(conn *websocket.Conn, writeMu *sync.Mutex, hash string, af *annotations.AnnotationFile) {
	_ = wsSendJSON(conn, writeMu, map[string]any{
		"type":        "annotations_data",
		"hash":        hash,
		"annotations": af,
	})
}

func emptyAnnotationFile() *annotations.AnnotationFile {
	return &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{},
		Annotations: []annotations.CocoAnnotation{},
		Categories:  []annotations.CocoCategory{},
	}
}

func annotationFilePath(annotationsDir string, singleFile bool, imagePath string) string {
	if singleFile {
		return filepath.Join(annotationsDir, "nemolab.json")
	}
	base := filepath.Base(imagePath)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	return filepath.Join(annotationsDir, stem+".json")
}

func migrateAnnotationFileIfNeeded(token, path, annotationsDir string, singleFile bool, imagePath string) error {
	if fileExists(path) {
		return nil
	}

	otherPath := annotationFilePath(annotationsDir, !singleFile, imagePath)
	if fileExists(otherPath) {
		af, err := annotations.ReadAnnotations(otherPath)
		if err != nil {
			return fmt.Errorf("read old-mode annotation file %q: %w", otherPath, err)
		}
		if err := annotations.WriteAnnotations(path, af); err != nil {
			return fmt.Errorf("write migrated annotation file %q: %w", path, err)
		}
		if err := os.Remove(otherPath); err != nil {
			return fmt.Errorf("remove old-mode annotation file %q: %w", otherPath, err)
		}
		log.Printf("ws annotations migrated token=%s old=%s new=%s", tokenPrefix(token), otherPath, path)
		return nil
	}

	imageDir := filepath.Dir(imagePath)
	base := filepath.Base(imagePath)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	imageSidecar := filepath.Join(imageDir, stem+".json")
	if imageSidecar == path || !fileExists(imageSidecar) {
		return nil
	}
	af, err := annotations.ReadAnnotations(imageSidecar)
	if err != nil {
		return fmt.Errorf("read image-sidecar annotation file %q: %w", imageSidecar, err)
	}
	if err := annotations.WriteAnnotations(path, af); err != nil {
		return fmt.Errorf("write imported annotation file %q: %w", path, err)
	}
	log.Printf("ws annotations imported token=%s source=%s dest=%s", tokenPrefix(token), imageSidecar, path)
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func resetTaskAnnotationState(token, taskID, annotationsDir string, singleFile bool) {
	connectionsMu.Lock()
	defer connectionsMu.Unlock()
	if s := connections[token]; s != nil {
		s.activeTaskID = taskID
		s.annotationsDir = annotationsDir
		s.singleFile = singleFile
		s.activeAnnotationPath = ""
		s.activeAnnotationHash = ""
	}
}

func getOrLoadSharedAnnotations(path, token, hash string, lgr *logger.Logger) *annotations.AnnotationFile {
	annotationStoreMu.Lock()
	if entry := annotationStore[path]; entry != nil && entry.af != nil {
		cached := cloneAnnotationFile(entry.af)
		annotationStoreMu.Unlock()
		return cached
	}
	annotationStoreMu.Unlock()

	loaded, err := annotations.ReadAnnotations(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			loaded = emptyAnnotationFile()
		} else {
			log.Printf("ws load_annotations failed token=%s hash=%.16s path=%s err=%v", tokenPrefix(token), hash, path, err)
			logAppend(lgr, map[string]any{
				"type":  "annotations_error",
				"ts":    time.Now().Format(time.RFC3339),
				"hash":  hash,
				"path":  path,
				"error": err.Error(),
			})
			loaded = emptyAnnotationFile()
		}
	}

	annotationStoreMu.Lock()
	defer annotationStoreMu.Unlock()
	entry := annotationStore[path]
	if entry == nil {
		entry = &fileAnnotations{}
		annotationStore[path] = entry
	}
	if entry.af == nil {
		entry.af = cloneAnnotationFile(loaded)
	}
	return cloneAnnotationFile(entry.af)
}

func mergeAndStoreSharedAnnotations(
	path string,
	incoming *annotations.AnnotationFile,
	imagePath string,
	hash string,
	token string,
	lgr *logger.Logger,
) *annotations.AnnotationFile {
	annotationStoreMu.Lock()
	defer annotationStoreMu.Unlock()

	entry := annotationStore[path]
	if entry == nil {
		entry = &fileAnnotations{af: emptyAnnotationFile()}
		annotationStore[path] = entry
	}
	if entry.af == nil {
		entry.af = emptyAnnotationFile()
	}
	entry.af = mergeAnnotationFiles(entry.af, incoming)
	entry.hashCheckCtx = &pendingHashCheck{
		token:     token,
		hash:      hash,
		imagePath: imagePath,
	}
	entry.dirty = true
	if entry.timer != nil {
		entry.timer.Stop()
	}
	entry.timer = time.AfterFunc(10*time.Second, func() {
		flushAnnotationPath(path, lgr)
	})
	return cloneAnnotationFile(entry.af)
}

func mergeAnnotationFiles(existing, incoming *annotations.AnnotationFile) *annotations.AnnotationFile {
	base := cloneAnnotationFile(existing)
	inc := cloneAnnotationFile(incoming)
	if base == nil {
		base = emptyAnnotationFile()
	}
	if inc == nil {
		return base
	}

	targetImageID := 1
	if len(inc.Images) > 0 && inc.Images[0].ID != 0 {
		targetImageID = inc.Images[0].ID
	}

	imageOut := make([]annotations.CocoImage, 0, len(base.Images)+len(inc.Images))
	for _, img := range base.Images {
		if img.ID != targetImageID {
			imageOut = append(imageOut, img)
		}
	}
	existingImageByID := map[int]annotations.CocoImage{}
	for _, img := range base.Images {
		existingImageByID[img.ID] = img
	}
	for _, img := range inc.Images {
		if img.ID == targetImageID {
			prev := existingImageByID[img.ID]
			if img.NemolabHashSHA256 == "" {
				img.NemolabHashSHA256 = prev.NemolabHashSHA256
			}
			if img.NemolabHashAlgo == "" {
				img.NemolabHashAlgo = prev.NemolabHashAlgo
			}
			imageOut = append(imageOut, img)
		}
	}
	base.Images = imageOut

	catByID := map[int]annotations.CocoCategory{}
	for _, cat := range base.Categories {
		catByID[cat.ID] = cat
	}
	for _, cat := range inc.Categories {
		catByID[cat.ID] = cat
	}
	catIDs := make([]int, 0, len(catByID))
	for id := range catByID {
		catIDs = append(catIDs, id)
	}
	sort.Ints(catIDs)
	base.Categories = make([]annotations.CocoCategory, 0, len(catIDs))
	for _, id := range catIDs {
		base.Categories = append(base.Categories, catByID[id])
	}

	nextAnnotations := make([]annotations.CocoAnnotation, 0, len(base.Annotations)+len(inc.Annotations))
	for _, ann := range base.Annotations {
		if ann.ImageID != targetImageID {
			nextAnnotations = append(nextAnnotations, ann)
		}
	}
	incForTarget := make([]annotations.CocoAnnotation, 0, len(inc.Annotations))
	for _, ann := range inc.Annotations {
		if ann.ImageID == targetImageID {
			incForTarget = append(incForTarget, ann)
		}
	}
	sort.Slice(incForTarget, func(i, j int) bool { return incForTarget[i].ID < incForTarget[j].ID })
	nextAnnotations = append(nextAnnotations, incForTarget...)
	base.Annotations = nextAnnotations

	if len(inc.NemolabLabels) > 0 {
		base.NemolabLabels = append([]byte(nil), inc.NemolabLabels...)
	}
	if len(inc.NemolabComments) > 0 {
		base.NemolabComments = append([]byte(nil), inc.NemolabComments...)
	}
	if len(inc.NemolabAuthors) > 0 {
		base.NemolabAuthors = append([]byte(nil), inc.NemolabAuthors...)
	}

	return base
}

func cloneAnnotationFile(src *annotations.AnnotationFile) *annotations.AnnotationFile {
	if src == nil {
		return nil
	}
	out := &annotations.AnnotationFile{
		Images:          append([]annotations.CocoImage{}, src.Images...),
		Annotations:     append([]annotations.CocoAnnotation{}, src.Annotations...),
		Categories:      append([]annotations.CocoCategory{}, src.Categories...),
		NemolabLabels:   append([]byte(nil), src.NemolabLabels...),
		NemolabComments: append([]byte(nil), src.NemolabComments...),
		NemolabAuthors:  append([]byte(nil), src.NemolabAuthors...),
	}
	for i := range out.Annotations {
		out.Annotations[i].BBox = append([]float64{}, out.Annotations[i].BBox...)
		out.Annotations[i].Keypoints = append([]float64{}, out.Annotations[i].Keypoints...)
	}
	return out
}

func flushAnnotationPath(path string, lgr *logger.Logger) {
	annotationStoreMu.Lock()
	entry := annotationStore[path]
	if entry == nil {
		annotationStoreMu.Unlock()
		return
	}
	if !entry.dirty || entry.af == nil {
		entry.timer = nil
		annotationStoreMu.Unlock()
		return
	}
	snapshot := cloneAnnotationFile(entry.af)
	hashCheckCtx := clonePendingHashCheck(entry.hashCheckCtx)
	entry.dirty = false
	entry.timer = nil
	annotationStoreMu.Unlock()

	if err := annotations.WriteAnnotations(path, snapshot); err != nil {
		log.Printf("ws save_annotations flush failed path=%s err=%v", path, err)
		logAppend(lgr, map[string]any{
			"type":  "annotations_error",
			"ts":    time.Now().Format(time.RFC3339),
			"path":  path,
			"error": err.Error(),
		})
		annotationStoreMu.Lock()
		if e := annotationStore[path]; e != nil {
			e.dirty = true
		}
		annotationStoreMu.Unlock()
		return
	}
	logAppend(lgr, map[string]any{
		"type": "annotations_saved",
		"ts":   time.Now().Format(time.RFC3339),
		"path": path,
	})
	if hashCheckCtx != nil {
		go verifyImageHashAfterWrite(path, hashCheckCtx, lgr)
	}
}

func flushAnnotationPathNow(path string, lgr *logger.Logger) {
	annotationStoreMu.Lock()
	entry := annotationStore[path]
	if entry == nil || !entry.dirty || entry.af == nil {
		annotationStoreMu.Unlock()
		return
	}
	if entry.timer != nil {
		entry.timer.Stop()
		entry.timer = nil
	}
	snapshot := cloneAnnotationFile(entry.af)
	hashCheckCtx := clonePendingHashCheck(entry.hashCheckCtx)
	entry.dirty = false
	annotationStoreMu.Unlock()

	if err := annotations.WriteAnnotations(path, snapshot); err != nil {
		log.Printf("ws save_annotations immediate flush failed path=%s err=%v", path, err)
		logAppend(lgr, map[string]any{
			"type":  "annotations_error",
			"ts":    time.Now().Format(time.RFC3339),
			"path":  path,
			"error": err.Error(),
		})
		annotationStoreMu.Lock()
		if e := annotationStore[path]; e != nil {
			e.dirty = true
		}
		annotationStoreMu.Unlock()
		return
	}
	if hashCheckCtx != nil {
		go verifyImageHashAfterWrite(path, hashCheckCtx, lgr)
	}
}

func clonePendingHashCheck(src *pendingHashCheck) *pendingHashCheck {
	if src == nil {
		return nil
	}
	return &pendingHashCheck{
		token:     src.token,
		hash:      src.hash,
		imagePath: src.imagePath,
	}
}

func verifyImageHashAfterWrite(path string, ctx *pendingHashCheck, lgr *logger.Logger) {
	if ctx == nil || ctx.imagePath == "" {
		return
	}

	computedHash, err := computeImageSHA256(ctx.imagePath)
	if err != nil {
		log.Printf("ws image hash compute failed path=%s image=%s err=%v", path, ctx.imagePath, err)
		return
	}

	annotationStoreMu.Lock()
	entry := annotationStore[path]
	if entry == nil || entry.af == nil {
		annotationStoreMu.Unlock()
		return
	}
	imageIndex := findImageIndexByPath(entry.af.Images, ctx.imagePath)
	if imageIndex < 0 {
		annotationStoreMu.Unlock()
		return
	}
	storedHash := strings.ToLower(strings.TrimSpace(entry.af.Images[imageIndex].NemolabHashSHA256))
	if storedHash == "" {
		entry.af.Images[imageIndex].NemolabHashSHA256 = computedHash
		entry.af.Images[imageIndex].NemolabHashAlgo = "sha256"
		snapshot := cloneAnnotationFile(entry.af)
		annotationStoreMu.Unlock()
		if err := annotations.WriteAnnotations(path, snapshot); err != nil {
			log.Printf("ws image hash writeback failed path=%s image=%s err=%v", path, ctx.imagePath, err)
			logAppend(lgr, map[string]any{
				"type":  "annotations_error",
				"ts":    time.Now().Format(time.RFC3339),
				"path":  path,
				"error": err.Error(),
			})
		}
		return
	}
	annotationStoreMu.Unlock()

	if storedHash == computedHash {
		return
	}
	sendImageHashMismatch(ctx.token, ctx.hash, ctx.imagePath, computedHash)
}

func findImageIndexByPath(images []annotations.CocoImage, imagePath string) int {
	if len(images) == 0 {
		return -1
	}
	cleanPath := filepath.Clean(imagePath)
	base := filepath.Base(cleanPath)
	for i, img := range images {
		name := strings.TrimSpace(img.FileName)
		if name == "" {
			continue
		}
		if filepath.Clean(name) == cleanPath || filepath.Base(name) == base {
			return i
		}
	}
	if len(images) == 1 {
		return 0
	}
	return -1
}

func computeImageSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	buf := make([]byte, 1024*1024)
	if _, err := io.CopyBuffer(h, f, buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func sendImageHashMismatch(token, hash, imagePath, imageHash string) {
	if token == "" || imagePath == "" || imageHash == "" {
		return
	}
	type liveConn struct {
		conn    *websocket.Conn
		writeMu *sync.Mutex
	}
	liveConnsMu.Lock()
	targets := make([]liveConn, 0, len(liveConns))
	for conn, info := range liveConns {
		if info.token != token {
			continue
		}
		targets = append(targets, liveConn{conn: conn, writeMu: info.writeMu})
	}
	liveConnsMu.Unlock()
	for _, target := range targets {
		_ = wsSendJSON(target.conn, target.writeMu, map[string]any{
			"type": "image_hash_mismatch",
			"hash": hash,
			"file": imagePath,
		})
	}
}

func setActiveAnnotationPath(token, path, hash string) {
	connectionsMu.Lock()
	defer connectionsMu.Unlock()
	if s := connections[token]; s != nil {
		s.activeAnnotationPath = path
		s.activeAnnotationHash = hash
	}
}

func broadcastAnnotationsData(path, originHash string, af *annotations.AnnotationFile, originConn *websocket.Conn) {
	type target struct {
		conn    *websocket.Conn
		writeMu *sync.Mutex
		hash    string
	}

	liveConnsMu.Lock()
	allLive := make([]struct {
		conn    *websocket.Conn
		token   string
		writeMu *sync.Mutex
	}, 0, len(liveConns))
	for conn, info := range liveConns {
		allLive = append(allLive, struct {
			conn    *websocket.Conn
			token   string
			writeMu *sync.Mutex
		}{conn: conn, token: info.token, writeMu: info.writeMu})
	}
	liveConnsMu.Unlock()

	targets := make([]target, 0, len(allLive))
	for _, live := range allLive {
		if live.conn == originConn {
			continue
		}
		connectionsMu.Lock()
		state := connections[live.token]
		matches := state != nil && state.activeAnnotationPath == path
		hash := originHash
		if matches && state.activeAnnotationHash != "" {
			hash = state.activeAnnotationHash
		}
		connectionsMu.Unlock()
		if !matches {
			continue
		}
		targets = append(targets, target{conn: live.conn, writeMu: live.writeMu, hash: hash})
	}

	for _, t := range targets {
		sendAnnotationsData(t.conn, t.writeMu, t.hash, af)
	}
}

func registerLiveConn(token string, conn *websocket.Conn, writeMu *sync.Mutex) {
	liveConnsMu.Lock()
	defer liveConnsMu.Unlock()
	liveConns[conn] = struct {
		token   string
		writeMu *sync.Mutex
	}{token: token, writeMu: writeMu}
}

func unregisterLiveConn(conn *websocket.Conn) {
	liveConnsMu.Lock()
	defer liveConnsMu.Unlock()
	delete(liveConns, conn)
}

func flushActiveAnnotationOnDisconnect(token string, lgr *logger.Logger) {
	connectionsMu.Lock()
	path := ""
	if s := connections[token]; s != nil {
		path = s.activeAnnotationPath
	}
	connectionsMu.Unlock()
	if path == "" {
		return
	}
	flushAnnotationPathNow(path, lgr)
}

func readManifestLevels(hash string) (int, error) {
	path := tiles.ManifestPathForHash(hash)
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	var manifest struct {
		Levels int `json:"levels"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return 0, err
	}
	if manifest.Levels < 1 {
		return 0, errors.New("invalid manifest levels")
	}
	return manifest.Levels, nil
}

type imageItem struct {
	Filename string `json:"filename"`
	Hash     string `json:"hash"`
}

func listTaskImages(imagesRoot string) ([]imageItem, map[string]string, error) {
	files, err := listImageFiles(imagesRoot)
	if err != nil {
		return nil, nil, err
	}
	items := make([]imageItem, 0, len(files))
	hashToPath := make(map[string]string, len(files))

	absRoot, err := filepath.Abs(imagesRoot)
	if err != nil {
		return nil, nil, err
	}
	for _, path := range files {
		canonical, err := canonicalPath(path)
		if err != nil {
			return nil, nil, fmt.Errorf("canonicalize image path %q: %w", path, err)
		}
		hash := tiles.HashForPath(canonical)
		rel, err := filepath.Rel(absRoot, path)
		if err != nil {
			continue
		}
		items = append(items, imageItem{
			Filename: filepath.ToSlash(rel),
			Hash:     hash,
		})
		hashToPath[hash] = canonical
	}
	return items, hashToPath, nil
}

func taskImagesPath(db *sql.DB, taskID string) (string, error) {
	if strings.TrimSpace(taskID) == "" {
		return "", nil
	}
	var imagesPath string
	if err := db.QueryRow("SELECT images FROM tasks WHERE id = ?", taskID).Scan(&imagesPath); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return imagesPath, nil
}

func taskAnnotationsConfig(db *sql.DB, taskID string) (string, bool, error) {
	if strings.TrimSpace(taskID) == "" {
		return "", false, nil
	}
	var annotationsPath string
	var checkmark int
	if err := db.QueryRow("SELECT annotations, checkmark FROM tasks WHERE id = ?", taskID).Scan(&annotationsPath, &checkmark); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return annotationsPath, checkmark != 0, nil
}

func listImageFiles(root string) ([]string, error) {
	if strings.TrimSpace(root) == "" {
		return []string{}, nil
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		return []string{}, nil
	}

	paths := make([]string, 0)
	err = filepath.WalkDir(absRoot, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if isImageExt(filepath.Ext(path)) {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	return paths, nil
}

func canonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	return canonical, nil
}

func isImageExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".png", ".jpg", ".jpeg", ".tif", ".tiff":
		return true
	default:
		return false
	}
}

func payloadMap(msg map[string]any) map[string]any {
	if entry, ok := msg["entry"].(map[string]any); ok {
		return entry
	}
	return msg
}

func prefetchHashes(msg map[string]any, entry map[string]any) []string {
	if hashes := toStringSlice(msg["hashes"]); len(hashes) > 0 {
		return hashes
	}
	return toStringSlice(entry["hashes"])
}

func toStringSlice(raw any) []string {
	switch v := raw.(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			s, ok := item.(string)
			if ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func storeHashMap(token string, hashToPath map[string]string) {
	connectionsMu.Lock()
	defer connectionsMu.Unlock()
	if s := connections[token]; s != nil {
		s.hashToPath = copyHashMap(hashToPath)
	}
}

func loadHashMap(token string) map[string]string {
	connectionsMu.Lock()
	defer connectionsMu.Unlock()
	if s := connections[token]; s != nil {
		return copyHashMap(s.hashToPath)
	}
	return map[string]string{}
}

func copyHashMap(src map[string]string) map[string]string {
	out := make(map[string]string, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

func nextPrefetchSeq(token string) uint64 {
	connectionsMu.Lock()
	defer connectionsMu.Unlock()
	if s := connections[token]; s != nil {
		s.prefetchSeq++
		return s.prefetchSeq
	}
	return 0
}

func isCurrentPrefetchSeq(token string, seq uint64) bool {
	connectionsMu.Lock()
	defer connectionsMu.Unlock()
	if s := connections[token]; s != nil {
		return s.prefetchSeq == seq
	}
	return false
}

func wsSendJSON(conn *websocket.Conn, writeMu *sync.Mutex, payload map[string]any) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	return websocket.JSON.Send(conn, payload)
}

// logAppend appends an entry to lgr if non-nil; silently no-ops otherwise.
func logAppend(lgr *logger.Logger, entry map[string]any) {
	if lgr != nil {
		_ = lgr.Append(entry)
	}
}

// tokenPrefix returns the first up-to-8 characters for safe log correlation.
func tokenPrefix(token string) string {
	if len(token) <= 8 {
		return token
	}
	return token[:8]
}
