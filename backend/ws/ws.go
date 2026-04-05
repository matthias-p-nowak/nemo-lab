package ws

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/matthias-p-nowak/nemo-lab/auth"
	"github.com/matthias-p-nowak/nemo-lab/logger"
	"github.com/matthias-p-nowak/nemo-lab/tiles"
	"golang.org/x/net/websocket"
)

type connState struct {
	count        int
	activeTaskID string
	hashToPath   map[string]string
	prefetchSeq  uint64
}

var (
	connectionsMu sync.Mutex
	connections   = map[string]*connState{}
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
			log.Printf("ws connect token=%s active=%d", cookie.Value, active)

			defer func() {
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
				default:
					if msgType == "" {
						continue
					}
				}
			}
		}).ServeHTTP(w, r)
	}
}

func handleSetActiveTask(
	db *sql.DB,
	token string,
	conn *websocket.Conn,
	writeMu *sync.Mutex,
	lgr *logger.Logger,
	taskID string,
) {
	connectionsMu.Lock()
	if s := connections[token]; s != nil {
		s.activeTaskID = taskID
	}
	connectionsMu.Unlock()

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
			continue
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
		return abs, nil
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
