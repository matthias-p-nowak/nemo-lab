package annotations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReadAnnotations_PlainCOCO(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"images": []any{
			map[string]any{
				"id":                  1,
				"file_name":           "img.png",
				"width":               100,
				"height":              50,
				"nemolab_hash_sha256": "abc123",
				"nemolab_hash_algo":   "sha256",
			},
		},
		"annotations": []any{
			map[string]any{"id": 10, "image_id": 1, "category_id": 7, "keypoints": []any{12.0, 8.0, 2.0}, "num_keypoints": 1},
		},
		"categories": []any{
			map[string]any{"id": 7, "name": "Cell"},
		},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if len(af.Images) != 1 || af.Images[0].FileName != "img.png" {
		t.Fatalf("unexpected images: %#v", af.Images)
	}
	if af.Images[0].NemolabHashSHA256 != "abc123" || af.Images[0].NemolabHashAlgo != "sha256" {
		t.Fatalf("expected image hash fields preserved, got %#v", af.Images[0])
	}
	if len(af.Annotations) != 1 || af.Annotations[0].NumKeypoints != 1 {
		t.Fatalf("unexpected annotations: %#v", af.Annotations)
	}
	if len(af.Categories) != 1 || af.Categories[0].Name != "Cell" {
		t.Fatalf("unexpected categories: %#v", af.Categories)
	}
}

func TestReadAnnotations_ExtendedCOCOSidecarPreserved(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"images": []any{map[string]any{"id": 1, "file_name": "a.png", "width": 20, "height": 10}},
		"annotations": []any{
			map[string]any{"id": 1, "image_id": 1, "category_id": 2, "keypoints": []any{1.0, 2.0, 2.0}, "num_keypoints": 1},
		},
		"categories": []any{map[string]any{"id": 2, "name": "X"}},
		"nemolab_labels": map[string]any{
			"root": []any{"A", "B"},
		},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if len(af.NemolabLabels) == 0 {
		t.Fatalf("expected nemolab_labels to be preserved")
	}
	var got map[string]any
	if err := json.Unmarshal(af.NemolabLabels, &got); err != nil {
		t.Fatalf("unmarshal sidecar failed: %v", err)
	}
	if _, ok := got["root"]; !ok {
		t.Fatalf("unexpected sidecar content: %#v", got)
	}
}

func TestReadAnnotations_LenientMissingArrays(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"images": []any{map[string]any{"id": 1, "file_name": "a.png", "width": 10, "height": 10}},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if af.Annotations == nil || len(af.Annotations) != 0 {
		t.Fatalf("expected empty non-nil annotations, got %#v", af.Annotations)
	}
	if af.Categories == nil || len(af.Categories) != 0 {
		t.Fatalf("expected empty non-nil categories, got %#v", af.Categories)
	}
}

func TestReadAnnotations_LabelMePolygonPreserved(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"imagePath":   "poly.png",
		"imageWidth":  20,
		"imageHeight": 20,
		"shapes": []any{
			map[string]any{
				"label":      "Tumor",
				"shape_type": "polygon",
				"points":     []any{[]any{5.0, 5.0}, []any{15.0, 5.0}, []any{10.0, 15.0}},
			},
		},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if len(af.Annotations) != 1 {
		t.Fatalf("expected one annotation, got %d", len(af.Annotations))
	}
	ann := af.Annotations[0]
	if ann.Keypoints != nil && len(ann.Keypoints) > 0 {
		t.Fatalf("expected no keypoints for polygon, got %#v", ann.Keypoints)
	}
	seg, ok := ann.Segmentation.([]any)
	if !ok || len(seg) != 1 {
		t.Fatalf("expected one polygon component, got %#v", ann.Segmentation)
	}
	part, ok := seg[0].([]any)
	if !ok {
		t.Fatalf("expected polygon part []any, got %T", seg[0])
	}
	got := make([]float64, 0, len(part))
	for _, v := range part {
		f, ok := v.(float64)
		if !ok {
			t.Fatalf("expected numeric polygon coordinate, got %T", v)
		}
		got = append(got, f)
	}
	want := []float64{5, 5, 15, 5, 10, 15}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("polygon coords mismatch: got=%v want=%v", got, want)
	}
	if ann.Area != 50 {
		t.Fatalf("expected shoelace area 50, got %f", ann.Area)
	}
}

func TestReadAnnotations_LabelMePoint(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"imagePath":   "point.png",
		"imageWidth":  10,
		"imageHeight": 10,
		"shapes": []any{
			map[string]any{
				"label":      "Point",
				"shape_type": "point",
				"points":     []any{[]any{4.0, 6.0}},
			},
		},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if len(af.Annotations) != 1 {
		t.Fatalf("expected one annotation, got %d", len(af.Annotations))
	}
	ann := af.Annotations[0]
	if ann.NumKeypoints != 1 || len(ann.Keypoints) != 3 {
		t.Fatalf("expected one keypoint triplet, got num=%d keypoints=%#v", ann.NumKeypoints, ann.Keypoints)
	}
}

func TestReadAnnotations_LabelMeRectangle(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"imagePath":   "rect.png",
		"imageWidth":  20,
		"imageHeight": 20,
		"shapes": []any{
			map[string]any{
				"label":      "Rect",
				"shape_type": "rectangle",
				"points":     []any{[]any{2.0, 3.0}, []any{10.0, 15.0}},
			},
		},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if len(af.Annotations) != 1 {
		t.Fatalf("expected one annotation, got %d", len(af.Annotations))
	}
	ann := af.Annotations[0]
	if len(ann.BBox) != 4 {
		t.Fatalf("expected bbox with 4 elements, got %#v", ann.BBox)
	}
}

func TestReadAnnotations_CocoPolygonSegmentationPreserved(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"images": []any{map[string]any{"id": 1, "file_name": "poly.png", "width": 30, "height": 30}},
		"annotations": []any{
			map[string]any{
				"id":          1,
				"image_id":    1,
				"category_id": 1,
				"segmentation": []any{
					[]any{5.0, 5.0, 20.0, 5.0, 10.0, 20.0},
				},
			},
		},
		"categories": []any{map[string]any{"id": 1, "name": "A"}},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if len(af.Annotations) != 1 {
		t.Fatalf("expected one annotation, got %d", len(af.Annotations))
	}
	ann := af.Annotations[0]
	seg, ok := ann.Segmentation.([]any)
	if !ok || len(seg) != 1 {
		t.Fatalf("expected one polygon component, got %#v", ann.Segmentation)
	}
	part, ok := seg[0].([]any)
	if !ok {
		t.Fatalf("expected polygon part []any, got %T", seg[0])
	}
	got := make([]float64, 0, len(part))
	for _, v := range part {
		f, ok := v.(float64)
		if !ok {
			t.Fatalf("expected numeric polygon coordinate, got %T", v)
		}
		got = append(got, f)
	}
	want := []float64{5, 5, 20, 5, 10, 20}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("polygon coords mismatch: got=%v want=%v", got, want)
	}
	if ann.Area != 112.5 {
		t.Fatalf("expected shoelace area 112.5, got %f", ann.Area)
	}
}

func TestReadAnnotations_CocoRLESegmentationConvertedToPolygon(t *testing.T) {
	path := writeJSONFixture(t, map[string]any{
		"images": []any{map[string]any{"id": 1, "file_name": "rle.png", "width": 5, "height": 5}},
		"annotations": []any{
			map[string]any{
				"id":          1,
				"image_id":    1,
				"category_id": 1,
				"segmentation": map[string]any{
					"size":   []any{5, 5},
					"counts": []any{6, 2, 3, 2, 12},
				},
			},
		},
		"categories": []any{map[string]any{"id": 1, "name": "A"}},
	})
	af, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if len(af.Annotations) != 1 {
		t.Fatalf("expected one annotation, got %d", len(af.Annotations))
	}
	seg, ok := af.Annotations[0].Segmentation.([]any)
	if !ok || len(seg) != 1 {
		t.Fatalf("expected one polygon component converted from rle, got %#v", af.Annotations[0].Segmentation)
	}
	part, ok := seg[0].([]any)
	if !ok {
		t.Fatalf("expected polygon part []any, got %T", seg[0])
	}
	if len(part) < 6 || len(part)%2 != 0 {
		t.Fatalf("expected valid flat polygon coordinates, got len=%d", len(part))
	}
	if af.Annotations[0].Area <= 0 {
		t.Fatalf("expected area > 0 after rle conversion, got %f", af.Annotations[0].Area)
	}
}

func TestReadAnnotations_NonExistentFile(t *testing.T) {
	_, err := ReadAnnotations(filepath.Join(t.TempDir(), "missing.json"))
	if err == nil {
		t.Fatalf("expected error for missing file")
	}
}

func TestWriteAnnotations_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "roundtrip.json")
	in := &AnnotationFile{
		Images:      []CocoImage{{ID: 1, FileName: "x.png", Width: 10, Height: 11, NemolabHashSHA256: "deadbeef", NemolabHashAlgo: "sha256"}},
		Annotations: []CocoAnnotation{{ID: 1, ImageID: 1, CategoryID: 2, Keypoints: []float64{3, 4, 2}, NumKeypoints: 1}},
		Categories:  []CocoCategory{{ID: 2, Name: "Cell"}},
	}
	if err := WriteAnnotations(path, in); err != nil {
		t.Fatalf("WriteAnnotations failed: %v", err)
	}
	out, err := ReadAnnotations(path)
	if err != nil {
		t.Fatalf("ReadAnnotations failed: %v", err)
	}
	if !reflect.DeepEqual(in.Images, out.Images) {
		t.Fatalf("images mismatch: in=%#v out=%#v", in.Images, out.Images)
	}
	if !reflect.DeepEqual(in.Categories, out.Categories) {
		t.Fatalf("categories mismatch: in=%#v out=%#v", in.Categories, out.Categories)
	}
	if len(out.Annotations) != 1 || out.Annotations[0].NumKeypoints != 1 {
		t.Fatalf("unexpected annotations after roundtrip: %#v", out.Annotations)
	}
}

func TestWriteAnnotations_AtomicWriteRemovesTmp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "atomic.json")
	in := &AnnotationFile{
		Images: []CocoImage{{ID: 1, FileName: "x.png", Width: 1, Height: 1}},
	}
	if err := WriteAnnotations(path, in); err != nil {
		t.Fatalf("WriteAnnotations failed: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected output file to exist: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("expected temp file to be removed, stat err=%v", err)
	}
}

func TestWriteAnnotations_OmitsNilSidecarKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nosidecar.json")
	in := &AnnotationFile{
		Images:      []CocoImage{{ID: 1, FileName: "x.png", Width: 1, Height: 1}},
		Annotations: []CocoAnnotation{},
		Categories:  []CocoCategory{},
	}
	if err := WriteAnnotations(path, in); err != nil {
		t.Fatalf("WriteAnnotations failed: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read output failed: %v", err)
	}
	var top map[string]any
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatalf("unmarshal output failed: %v", err)
	}
	if _, ok := top["nemolab_labels"]; ok {
		t.Fatalf("did not expect nemolab_labels key when sidecar is nil")
	}
}

func TestWriteAnnotations_CreatesParentDirs(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "a", "b", "c", "out.json")
	if err := WriteAnnotations(path, &AnnotationFile{Images: []CocoImage{{ID: 1}}}); err != nil {
		t.Fatalf("WriteAnnotations failed: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected output file to exist: %v", err)
	}
}

func writeJSONFixture(t *testing.T, payload any) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fixture.json")
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal fixture failed: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("write fixture failed: %v", err)
	}
	return path
}
