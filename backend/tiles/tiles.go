package tiles

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	stddraw "image/draw"
	_ "image/jpeg"
	"image/png"
	"io/fs"
	"log"
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
	defaultTileWorkers   = 4
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
	tileWorkers   int

	inFlightMu sync.Mutex
	inFlight   map[string]*sync.Mutex
	stopCh     chan struct{}
}

// Configure initializes the package-global tile service.
func Configure(cacheDir string, cacheLimitMB int64, evictIntervalRaw string, tileWorkers int) {
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
	if tileWorkers <= 0 {
		tileWorkers = defaultTileWorkers
	}
	_ = os.MkdirAll(cacheDir, 0o755)

	svc := &Service{
		cacheDir:      cacheDir,
		cacheLimitB:   cacheLimitMB * 1024 * 1024,
		evictInterval: interval,
		tileWorkers:   tileWorkers,
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
	Configure(defaultCacheDir, defaultCacheLimitMB, defaultEvictInterval.String(), defaultTileWorkers)
	serviceMu.RLock()
	defer serviceMu.RUnlock()
	return service
}

// EnsureGeneratedByPath generates tiles for the image at absPath if missing.
// It returns the cached manifest path on success.
func EnsureGeneratedByPath(absPath string) (string, error) {
	svc := ensureService()
	return svc.ensureGeneratedByPath(absPath, nil, nil)
}

// GenerateByPathWithProgress generates tiles for absPath, calling onLevel(level, totalLevels)
// after each zoom level is written to disk. Level 0 is coarsest; level totalLevels-1 is full res.
// If tiles are already cached, onLevel is not called and the manifest path is returned immediately.
func GenerateByPathWithProgress(absPath string, onLevel func(level, totalLevels int)) (string, error) {
	svc := ensureService()
	return svc.ensureGeneratedByPath(absPath, onLevel, nil)
}

// GenerateByPathWithProgressAndEvents is like GenerateByPathWithProgress, but also emits
// structured generation events through onEvent. Event maps always include a "type" field.
func GenerateByPathWithProgressAndEvents(
	absPath string,
	onLevel func(level, totalLevels int),
	onEvent func(map[string]any),
) (string, error) {
	svc := ensureService()
	return svc.ensureGeneratedByPath(absPath, onLevel, onEvent)
}

// ManifestPathForHash returns the expected cached manifest path for a hash.
func ManifestPathForHash(hash string) string {
	svc := ensureService()
	return svc.manifestPath(hash)
}

func (s *Service) ensureGeneratedByPath(
	absPath string,
	onLevel func(level, totalLevels int),
	onEvent func(map[string]any),
) (string, error) {
	emit := func(kind string, fields map[string]any) {
		if onEvent == nil {
			return
		}
		entry := map[string]any{"type": kind}
		for k, v := range fields {
			entry[k] = v
		}
		onEvent(entry)
	}

	if strings.TrimSpace(absPath) == "" {
		return "", errors.New("invalid image path")
	}
	hash := HashForPath(absPath)
	manifestPath := s.manifestPath(hash)
	if _, err := os.Stat(s.completePath(hash)); err == nil {
		emit("tile_generation_cache_hit", map[string]any{
			"hash": hash,
		})
		return manifestPath, nil
	}

	lock := s.hashLock(hash)
	lock.Lock()
	defer lock.Unlock()

	if _, err := os.Stat(s.completePath(hash)); err == nil {
		emit("tile_generation_cache_hit", map[string]any{
			"hash": hash,
		})
		return manifestPath, nil
	}

	t0 := time.Now()
	log.Printf("tiles start hash=%.16s path=%s", hash, absPath)
	emit("tile_generation_start", map[string]any{
		"hash": hash,
		"path": absPath,
	})

	src, err := decodeImage(absPath)
	if err != nil {
		return "", err
	}
	b := src.Bounds()
	width, height := b.Dx(), b.Dy()
	totalLevels := computeLevels(width, height)
	log.Printf("tiles decoded hash=%.16s size=%dx%d levels=%d elapsed=%s", hash, width, height, totalLevels, time.Since(t0).Round(time.Millisecond))
	emit("tile_generation_decoded", map[string]any{
		"hash":         hash,
		"width":        width,
		"height":       height,
		"total_levels": totalLevels,
		"elapsed_ms":   time.Since(t0).Milliseconds(),
	})

	// Write full manifest up front — all fields are known before any tiles are written.
	if err := s.writeManifest(hash, width, height, totalLevels); err != nil {
		return "", err
	}

	_, _, _, err = s.generateTiles(hash, src, onLevel, onEvent, t0)
	if err != nil {
		return "", err
	}

	// Write sentinel only after all tiles succeed; absence triggers regeneration on retry.
	if err := os.WriteFile(s.completePath(hash), nil, 0o644); err != nil {
		return "", err
	}
	log.Printf("tiles complete hash=%.16s total=%s", hash, time.Since(t0).Round(time.Millisecond))
	emit("tile_generation_complete", map[string]any{
		"hash":       hash,
		"elapsed_ms": time.Since(t0).Milliseconds(),
	})
	return manifestPath, nil
}

func (s *Service) generateTiles(
	hash string,
	src image.Image,
	onLevel func(level, totalLevels int),
	onEvent func(map[string]any),
	t0 time.Time,
) (int, int, int, error) {
	emit := func(kind string, fields map[string]any) {
		if onEvent == nil {
			return
		}
		entry := map[string]any{"type": kind}
		for k, v := range fields {
			entry[k] = v
		}
		onEvent(entry)
	}

	b := src.Bounds()
	width := b.Dx()
	height := b.Dy()
	if width <= 0 || height <= 0 {
		return 0, 0, 0, errors.New("invalid image bounds")
	}
	levels := computeLevels(width, height)

	// Build mipmap chain by iterating from full-res (level N-1) down to coarsest
	// (level 0), downscaling each step from the previous level. This is faster
	// than downscaling every level independently from the original source.
	type levelWork struct {
		level  int
		img    image.Image
		lw, lh int
	}
	chain := make([]levelWork, levels)
	var prev image.Image = src
	for i := levels - 1; i >= 0; i-- {
		scale := math.Pow(2, float64(i-(levels-1)))
		lw := maxInt(1, int(math.Round(float64(width)*scale)))
		lh := maxInt(1, int(math.Round(float64(height)*scale)))
		if lw == width && lh == height {
			chain[i] = levelWork{i, prev, lw, lh}
		} else {
			scaled := resizeImage(prev, lw, lh)
			chain[i] = levelWork{i, scaled, lw, lh}
			prev = scaled
		}
	}
	log.Printf("tiles mipmap done hash=%.16s elapsed=%s", hash, time.Since(t0).Round(time.Millisecond))
	emit("tile_generation_mipmap_done", map[string]any{
		"hash":       hash,
		"elapsed_ms": time.Since(t0).Milliseconds(),
	})

	type tileJob struct {
		col, row int
	}

	for _, w := range chain {
		level, scaled, lw, lh := w.level, w.img, w.lw, w.lh
		cols := ceilDiv(lw, tileSize)
		rows := ceilDiv(lh, tileSize)

		// Create all tile subdirectories before spawning workers.
		levelDir := filepath.Dir(s.tilePath(hash, level, 0, 0))
		if err := os.MkdirAll(levelDir, 0o755); err != nil {
			return 0, 0, 0, err
		}

		jobs := make(chan tileJob, cols*rows)
		for row := 0; row < rows; row++ {
			for col := 0; col < cols; col++ {
				jobs <- tileJob{col, row}
			}
		}
		close(jobs)

		errs := make(chan error, s.tileWorkers)
		for range s.tileWorkers {
			go func() {
				for j := range jobs {
					x0 := j.col * tileSize
					y0 := j.row * tileSize
					x1 := minInt(x0+tileSize, lw)
					y1 := minInt(y0+tileSize, lh)
					tile := image.NewRGBA(image.Rect(0, 0, x1-x0, y1-y0))
					stddraw.Draw(tile, tile.Bounds(), scaled, image.Pt(x0, y0), stddraw.Src)
					path := s.tilePath(hash, level, j.col, j.row)
					if err := writePNG(path, tile); err != nil {
						errs <- err
						return
					}
				}
				errs <- nil
			}()
		}
		for range s.tileWorkers {
			if err := <-errs; err != nil {
				return 0, 0, 0, err
			}
		}

		log.Printf("tiles level done hash=%.16s level=%d/%d size=%dx%d elapsed=%s", hash, level, levels-1, lw, lh, time.Since(t0).Round(time.Millisecond))
		emit("tile_generation_level_done", map[string]any{
			"hash":         hash,
			"level":        level,
			"total_levels": levels,
			"width":        lw,
			"height":       lh,
			"elapsed_ms":   time.Since(t0).Milliseconds(),
		})
		if onLevel != nil {
			onLevel(level, levels)
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

func (s *Service) completePath(hash string) string {
	return filepath.Join(s.hashRoot(hash), "tiles.complete")
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
	// Try native decoder first (PNG/JPEG via libpng/libjpeg-turbo).
	if img, err := decodeImageNative(path); img != nil || err != nil {
		return img, err
	}
	// Fall back to pure Go for other formats (TIFF, etc.).
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

// pngEncoder uses BestSpeed compression — tiles are cache-local so encode
// speed matters more than file size.
var pngEncoder = png.Encoder{CompressionLevel: png.BestSpeed}

func writePNG(path string, src image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return pngEncoder.Encode(f, src)
}

// resizeImage downscales src to the target width×height.
// When the target is exactly half the source dimensions (the mipmap case) it
// uses a fast 2×2 box filter operating directly on the RGBA pixel buffer.
// Any other ratio falls back to CatmullRom.
func resizeImage(src image.Image, width, height int) image.Image {
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	sb := src.Bounds()
	if sb.Dx() == width && sb.Dy() == height {
		stddraw.Draw(dst, dst.Bounds(), src, sb.Min, stddraw.Src)
		return dst
	}
	if sb.Dx() == width*2 && sb.Dy() == height*2 {
		boxFilter2x(dst, src)
		return dst
	}
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, sb, stddraw.Src, nil)
	return dst
}

// boxFilter2x downscales src into dst using a 2×2 box filter.
// src must be exactly twice the width and height of dst.
// Works on the raw RGBA pixel buffer of src for maximum throughput.
func boxFilter2x(dst *image.RGBA, src image.Image) {
	sw := src.Bounds().Dx()
	sh := src.Bounds().Dy()
	dw := sw / 2
	dh := sh / 2

	// Fast path: source is already *image.RGBA — operate on the raw pix buffer.
	if rgba, ok := src.(*image.RGBA); ok {
		sp := rgba.Stride
		dp := dst.Stride
		for y := 0; y < dh; y++ {
			srcRow0 := y * 2 * sp
			srcRow1 := srcRow0 + sp
			dstRow := y * dp
			for x := 0; x < dw; x++ {
				s0 := srcRow0 + x*2*4
				s1 := srcRow0 + (x*2+1)*4
				s2 := srcRow1 + x*2*4
				s3 := srcRow1 + (x*2+1)*4
				d := dstRow + x*4
				dst.Pix[d+0] = uint8((uint32(rgba.Pix[s0+0]) + uint32(rgba.Pix[s1+0]) + uint32(rgba.Pix[s2+0]) + uint32(rgba.Pix[s3+0])) >> 2)
				dst.Pix[d+1] = uint8((uint32(rgba.Pix[s0+1]) + uint32(rgba.Pix[s1+1]) + uint32(rgba.Pix[s2+1]) + uint32(rgba.Pix[s3+1])) >> 2)
				dst.Pix[d+2] = uint8((uint32(rgba.Pix[s0+2]) + uint32(rgba.Pix[s1+2]) + uint32(rgba.Pix[s2+2]) + uint32(rgba.Pix[s3+2])) >> 2)
				dst.Pix[d+3] = uint8((uint32(rgba.Pix[s0+3]) + uint32(rgba.Pix[s1+3]) + uint32(rgba.Pix[s2+3]) + uint32(rgba.Pix[s3+3])) >> 2)
			}
		}
		return
	}

	// Slow path: source implements image.Image but is not *image.RGBA.
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			r0, g0, b0, a0 := src.At(x*2, y*2).RGBA()
			r1, g1, b1, a1 := src.At(x*2+1, y*2).RGBA()
			r2, g2, b2, a2 := src.At(x*2, y*2+1).RGBA()
			r3, g3, b3, a3 := src.At(x*2+1, y*2+1).RGBA()
			dst.SetRGBA(x, y, color.RGBA{
				R: uint8(((r0 + r1 + r2 + r3) >> 2) >> 8),
				G: uint8(((g0 + g1 + g2 + g3) >> 2) >> 8),
				B: uint8(((b0 + b1 + b2 + b3) >> 2) >> 8),
				A: uint8(((a0 + a1 + a2 + a3) >> 2) >> 8),
			})
		}
	}
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
