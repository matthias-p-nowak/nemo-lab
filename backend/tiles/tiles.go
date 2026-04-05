package tiles

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	stddraw "image/draw"
	_ "image/jpeg"
	"image/png"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
)

const (
	tileSize             = 256
	defaultCacheDir      = "/tmp/nemo-lab/cache"
	defaultCacheLimitMB  = int64(512)
	defaultEvictInterval = 5 * time.Minute
	imagesDir            = "images"
)

var (
	serviceMu sync.RWMutex
	service   *Service
)

// Service manages on-demand tile generation and disk cache eviction.
type Service struct {
	cacheDir      string
	cacheLimitB   int64
	evictInterval time.Duration

	inFlightMu sync.Mutex
	inFlight   map[string]*sync.Mutex
	stopCh     chan struct{}
}

// Configure initializes the package-global tile service.
func Configure(cacheDir string, cacheLimitMB int64, evictIntervalRaw string) {
	interval, err := time.ParseDuration(evictIntervalRaw)
	if err != nil || interval <= 0 {
		interval = defaultEvictInterval
	}
	if strings.TrimSpace(cacheDir) == "" {
		cacheDir = defaultCacheDir
	}
	if cacheLimitMB <= 0 {
		cacheLimitMB = defaultCacheLimitMB
	}
	_ = os.MkdirAll(cacheDir, 0o755)

	svc := &Service{
		cacheDir:      cacheDir,
		cacheLimitB:   cacheLimitMB * 1024 * 1024,
		evictInterval: interval,
		inFlight:      make(map[string]*sync.Mutex),
		stopCh:        make(chan struct{}),
	}

	serviceMu.Lock()
	prev := service
	service = svc
	serviceMu.Unlock()
	if prev != nil {
		close(prev.stopCh)
	}

	go svc.evictLoop()
}

// NewHandler serves /images/{hash}/manifest.json and /images/{hash}/tiles/{z}/{x}_{y}.png.
// Other /images paths fall through to static file serving from images/.
func NewHandler() http.HandlerFunc {
	svc := ensureService()
	static := http.StripPrefix("/images/", http.FileServer(http.Dir(imagesDir)))

	return func(w http.ResponseWriter, r *http.Request) {
		req, err := parseRequestPath(r.URL.Path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.kind == requestFallback {
			static.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		switch req.kind {
		case requestManifest:
			w.Header().Set("Content-Type", "application/json")
			path := svc.manifestPath(req.hash)
			if _, err := os.Stat(path); err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					http.NotFound(w, r)
					return
				}
				http.Error(w, "manifest read failed", http.StatusInternalServerError)
				return
			}
			http.ServeFile(w, r, path)
			return
		case requestTile:
			path := svc.tilePath(req.hash, req.level, req.x, req.y)
			if _, err := os.Stat(path); err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					http.NotFound(w, r)
					return
				}
				http.Error(w, "tile read failed", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "image/png")
			http.ServeFile(w, r, path)
			return
		default:
			http.NotFound(w, r)
		}
	}
}

func ensureService() *Service {
	serviceMu.RLock()
	svc := service
	serviceMu.RUnlock()
	if svc != nil {
		return svc
	}
	Configure(defaultCacheDir, defaultCacheLimitMB, defaultEvictInterval.String())
	serviceMu.RLock()
	defer serviceMu.RUnlock()
	return service
}

// EnsureGeneratedByPath generates tiles for the image at absPath if missing.
// It returns the cached manifest path on success.
func EnsureGeneratedByPath(absPath string) (string, error) {
	svc := ensureService()
	return svc.ensureGeneratedByPath(absPath)
}

// ManifestPathForHash returns the expected cached manifest path for a hash.
func ManifestPathForHash(hash string) string {
	svc := ensureService()
	return svc.manifestPath(hash)
}

func (s *Service) ensureGeneratedByPath(absPath string) (string, error) {
	if strings.TrimSpace(absPath) == "" {
		return "", errors.New("invalid image path")
	}
	hash := HashForPath(absPath)
	manifestPath := s.manifestPath(hash)
	if _, err := os.Stat(manifestPath); err == nil {
		return manifestPath, nil
	}

	lock := s.hashLock(hash)
	lock.Lock()
	defer lock.Unlock()

	if _, err := os.Stat(manifestPath); err == nil {
		return manifestPath, nil
	}

	src, err := decodeImage(absPath)
	if err != nil {
		return "", err
	}
	width, height, levels, err := s.generateTiles(hash, src)
	if err != nil {
		return "", err
	}
	if err := s.writeManifest(hash, width, height, levels); err != nil {
		return "", err
	}
	return manifestPath, nil
}

func (s *Service) generateTiles(hash string, src image.Image) (int, int, int, error) {
	b := src.Bounds()
	width := b.Dx()
	height := b.Dy()
	if width <= 0 || height <= 0 {
		return 0, 0, 0, errors.New("invalid image bounds")
	}
	levels := computeLevels(width, height)

	for level := 0; level < levels; level++ {
		scale := math.Pow(2, float64(level-(levels-1)))
		lw := maxInt(1, int(math.Round(float64(width)*scale)))
		lh := maxInt(1, int(math.Round(float64(height)*scale)))

		scaled := resizeImage(src, lw, lh)
		cols := ceilDiv(lw, tileSize)
		rows := ceilDiv(lh, tileSize)
		for row := 0; row < rows; row++ {
			for col := 0; col < cols; col++ {
				x0 := col * tileSize
				y0 := row * tileSize
				x1 := minInt(x0+tileSize, lw)
				y1 := minInt(y0+tileSize, lh)
				tile := image.NewRGBA(image.Rect(0, 0, x1-x0, y1-y0))
				stddraw.Draw(tile, tile.Bounds(), scaled, image.Pt(x0, y0), stddraw.Src)
				path := s.tilePath(hash, level, col, row)
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					return 0, 0, 0, err
				}
				if err := writePNG(path, tile); err != nil {
					return 0, 0, 0, err
				}
			}
		}
	}

	return width, height, levels, nil
}

func (s *Service) writeManifest(hash string, width, height, levels int) error {
	manifest := struct {
		Width    int    `json:"width"`
		Height   int    `json:"height"`
		TileSize int    `json:"tile_size"`
		Levels   int    `json:"levels"`
		Tiles    string `json:"tiles"`
	}{
		Width:    width,
		Height:   height,
		TileSize: tileSize,
		Levels:   levels,
		Tiles:    "tiles/{z}/{x}_{y}.png",
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	path := s.manifestPath(hash)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}

func (s *Service) evictLoop() {
	ticker := time.NewTicker(s.evictInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.evictIfNeeded()
		case <-s.stopCh:
			return
		}
	}
}

func (s *Service) evictIfNeeded() {
	type item struct {
		path    string
		size    int64
		modTime time.Time
	}

	files := make([]item, 0)
	var total int64
	_ = filepath.WalkDir(s.cacheDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		size := info.Size()
		total += size
		files = append(files, item{
			path:    path,
			size:    size,
			modTime: info.ModTime(),
		})
		return nil
	})

	if total <= s.cacheLimitB {
		return
	}

	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	for _, f := range files {
		if total <= s.cacheLimitB {
			return
		}
		if err := os.Remove(f.path); err == nil {
			total -= f.size
		}
	}
}

func (s *Service) hashRoot(hash string) string {
	return filepath.Join(s.cacheDir, hash)
}

func (s *Service) manifestPath(hash string) string {
	return filepath.Join(s.hashRoot(hash), "manifest.json")
}

func (s *Service) tilePath(hash string, level, x, y int) string {
	return filepath.Join(
		s.hashRoot(hash),
		"tiles",
		strconv.Itoa(level),
		fmt.Sprintf("%d_%d.png", x, y),
	)
}

func (s *Service) hashLock(hash string) *sync.Mutex {
	s.inFlightMu.Lock()
	defer s.inFlightMu.Unlock()
	lock, ok := s.inFlight[hash]
	if !ok {
		lock = &sync.Mutex{}
		s.inFlight[hash] = lock
	}
	return lock
}

// HashForPath computes the SHA-256 cache key for an image canonical path.
func HashForPath(absPath string) string {
	sum := sha256.Sum256([]byte(absPath))
	return hex.EncodeToString(sum[:])
}

func findImageFile(stem string) (string, error) {
	if !isValidStem(stem) {
		return "", errors.New("invalid stem")
	}
	preferredExts := []string{".png", ".jpg", ".jpeg", ".tif", ".tiff"}
	for _, ext := range preferredExts {
		path := filepath.Join(imagesDir, stem+ext)
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, nil
		}
	}

	entries, err := os.ReadDir(imagesDir)
	if err != nil {
		return "", err
	}
	matches := make(map[string]string)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))
		base := strings.TrimSuffix(name, filepath.Ext(name))
		if base != stem {
			continue
		}
		for _, allowed := range preferredExts {
			if ext == allowed {
				matches[ext] = filepath.Join(imagesDir, name)
				break
			}
		}
	}
	for _, ext := range preferredExts {
		if path, ok := matches[ext]; ok {
			return path, nil
		}
	}
	return "", fs.ErrNotExist
}

func decodeImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

func writePNG(path string, src image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, src)
}

func resizeImage(src image.Image, width, height int) image.Image {
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	if src.Bounds().Dx() == width && src.Bounds().Dy() == height {
		stddraw.Draw(dst, dst.Bounds(), src, src.Bounds().Min, stddraw.Src)
		return dst
	}
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), stddraw.Src, nil)
	return dst
}

func computeLevels(width, height int) int {
	maxDim := maxInt(width, height)
	return int(math.Ceil(math.Log2(float64(maxDim)/float64(tileSize)))) + 1
}

type requestKind int

const (
	requestFallback requestKind = iota
	requestManifest
	requestTile
)

type parsedRequest struct {
	kind  requestKind
	hash  string
	level int
	x     int
	y     int
}

func parseRequestPath(path string) (parsedRequest, error) {
	trimmed := strings.TrimPrefix(path, "/images/")
	parts := strings.Split(trimmed, "/")

	if len(parts) == 2 && parts[1] == "manifest.json" {
		if !isValidHash(parts[0]) {
			return parsedRequest{}, errors.New("invalid hash")
		}
		return parsedRequest{kind: requestManifest, hash: parts[0]}, nil
	}

	if len(parts) == 4 && parts[1] == "tiles" {
		if !isValidHash(parts[0]) {
			return parsedRequest{}, errors.New("invalid hash")
		}
		level, err := strconv.Atoi(parts[2])
		if err != nil || level < 0 {
			return parsedRequest{}, errors.New("invalid level")
		}
		if !strings.HasSuffix(parts[3], ".png") {
			return parsedRequest{}, errors.New("invalid tile name")
		}
		base := strings.TrimSuffix(parts[3], ".png")
		xy := strings.Split(base, "_")
		if len(xy) != 2 {
			return parsedRequest{}, errors.New("invalid tile name")
		}
		x, err := strconv.Atoi(xy[0])
		if err != nil || x < 0 {
			return parsedRequest{}, errors.New("invalid x")
		}
		y, err := strconv.Atoi(xy[1])
		if err != nil || y < 0 {
			return parsedRequest{}, errors.New("invalid y")
		}
		return parsedRequest{kind: requestTile, hash: parts[0], level: level, x: x, y: y}, nil
	}

	if len(parts) > 1 && parts[1] == "tiles" {
		return parsedRequest{}, errors.New("invalid tile path")
	}
	if len(parts) > 1 && parts[1] == "manifest.json" {
		return parsedRequest{}, errors.New("invalid manifest path")
	}
	return parsedRequest{kind: requestFallback}, nil
}

func isValidHash(hash string) bool {
	if len(hash) != 64 {
		return false
	}
	for _, c := range hash {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func isValidStem(stem string) bool {
	if strings.TrimSpace(stem) == "" {
		return false
	}
	if stem == "." || stem == ".." {
		return false
	}
	if strings.Contains(stem, "/") || strings.Contains(stem, "\\") {
		return false
	}
	return true
}

func ceilDiv(n, d int) int {
	return (n + d - 1) / d
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
