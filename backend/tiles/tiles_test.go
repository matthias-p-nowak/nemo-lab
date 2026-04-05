package tiles

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandlerServesCachedManifestAndCroppedTiles(t *testing.T) {
	temp := t.TempDir()
	imagesPath := filepath.Join(temp, "images")
	cachePath := filepath.Join(temp, "cache")
	if err := os.MkdirAll(imagesPath, 0o755); err != nil {
		t.Fatalf("mkdir images: %v", err)
	}
	srcPath := filepath.Join(imagesPath, "sample.png")
	writeTestImage(t, srcPath, 300, 180)

	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(temp); err != nil {
		t.Fatalf("chdir temp: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(prevWD) })

	Configure(cachePath, 64, "1h", 2)
	handler := NewHandler()
	canonicalPath, err := filepath.Abs(srcPath)
	if err != nil {
		t.Fatalf("abs image path: %v", err)
	}
	hash := HashForPath(canonicalPath)

	if _, err := EnsureGeneratedByPath(canonicalPath); err != nil {
		t.Fatalf("ensure generated: %v", err)
	}

	manifestResp := httptest.NewRecorder()
	handler.ServeHTTP(
		manifestResp,
		httptest.NewRequest(http.MethodGet, "/images/"+hash+"/manifest.json", nil),
	)
	if manifestResp.Code != http.StatusOK {
		t.Fatalf("manifest status=%d body=%s", manifestResp.Code, manifestResp.Body.String())
	}

	var manifest struct {
		Width    int    `json:"width"`
		Height   int    `json:"height"`
		TileSize int    `json:"tile_size"`
		Levels   int    `json:"levels"`
		Tiles    string `json:"tiles"`
	}
	if err := json.Unmarshal(manifestResp.Body.Bytes(), &manifest); err != nil {
		t.Fatalf("unmarshal manifest: %v", err)
	}
	if manifest.Width != 300 || manifest.Height != 180 || manifest.TileSize != 256 || manifest.Levels != 2 {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	if manifest.Tiles != "tiles/{z}/{x}_{y}.png" {
		t.Fatalf("unexpected manifest tiles template: %q", manifest.Tiles)
	}

	tile0Resp := httptest.NewRecorder()
	handler.ServeHTTP(
		tile0Resp,
		httptest.NewRequest(http.MethodGet, "/images/"+hash+"/tiles/0/0_0.png", nil),
	)
	if tile0Resp.Code != http.StatusOK {
		t.Fatalf("tile0 status=%d", tile0Resp.Code)
	}
	tile0 := decodePNGForTest(t, tile0Resp.Body.Bytes())
	if tile0.Bounds().Dx() != 150 || tile0.Bounds().Dy() != 90 {
		t.Fatalf("unexpected level0 tile size: %dx%d", tile0.Bounds().Dx(), tile0.Bounds().Dy())
	}

	tileEdgeResp := httptest.NewRecorder()
	handler.ServeHTTP(
		tileEdgeResp,
		httptest.NewRequest(http.MethodGet, "/images/"+hash+"/tiles/1/1_0.png", nil),
	)
	if tileEdgeResp.Code != http.StatusOK {
		t.Fatalf("edge tile status=%d", tileEdgeResp.Code)
	}
	tileEdge := decodePNGForTest(t, tileEdgeResp.Body.Bytes())
	if tileEdge.Bounds().Dx() != 44 || tileEdge.Bounds().Dy() != 180 {
		t.Fatalf("unexpected edge tile size: %dx%d", tileEdge.Bounds().Dx(), tileEdge.Bounds().Dy())
	}

	staticResp := httptest.NewRecorder()
	handler.ServeHTTP(staticResp, httptest.NewRequest(http.MethodGet, "/images/sample.png", nil))
	if staticResp.Code != http.StatusOK {
		t.Fatalf("static fallback status=%d", staticResp.Code)
	}
}

func TestHandlerReturns404WhenManifestNotCached(t *testing.T) {
	temp := t.TempDir()
	if err := os.MkdirAll(filepath.Join(temp, "images"), 0o755); err != nil {
		t.Fatalf("mkdir images: %v", err)
	}

	prevWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(temp); err != nil {
		t.Fatalf("chdir temp: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(prevWD) })

	Configure(filepath.Join(temp, "cache"), 64, "1h", 2)
	handler := NewHandler()
	missingHash := HashForPath("/tmp/non-existent-image.png")

	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/images/"+missingHash+"/manifest.json", nil))
	if resp.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func writeTestImage(t *testing.T, path string, width, height int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 120, A: 255})
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create image: %v", err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatalf("encode image: %v", err)
	}
}

func decodePNGForTest(t *testing.T, raw []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	return img
}
