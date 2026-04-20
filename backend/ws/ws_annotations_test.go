package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/matthias-p-nowak/nemo-lab/annotations"
)

func TestResolveImagePath(t *testing.T) {
	token := "tok-image"
	hash := "hash-image"
	imagePath := filepath.Join(t.TempDir(), "img.png")
	restore := setConnStateForTest(token, &connState{
		hashToPath: map[string]string{hash: imagePath},
	})
	defer restore()

	got, ok := ResolveImagePath(token, hash)
	if !ok {
		t.Fatalf("expected image path to resolve")
	}
	if got != imagePath {
		t.Fatalf("unexpected image path: got=%q want=%q", got, imagePath)
	}
}

func TestResolveAnnotationPath(t *testing.T) {
	token := "tok-ann"
	hash := "hash-ann"
	root := t.TempDir()
	imagePath := filepath.Join(root, "nested", "sample.tif")
	restore := setConnStateForTest(token, &connState{
		hashToPath:     map[string]string{hash: imagePath},
		annotationsDir: filepath.Join(root, "anns"),
		singleFile:     false,
	})
	defer restore()

	got, ok := ResolveAnnotationPath(token, hash)
	if !ok {
		t.Fatalf("expected annotation path to resolve")
	}
	want := filepath.Join(root, "anns", "sample.json")
	if got != want {
		t.Fatalf("unexpected annotation path: got=%q want=%q", got, want)
	}
}

func TestResolveAnnotationPathMissingAnnotationsDir(t *testing.T) {
	token := "tok-ann-missing"
	hash := "hash-ann-missing"
	restore := setConnStateForTest(token, &connState{
		hashToPath: map[string]string{hash: "/tmp/sample.tif"},
	})
	defer restore()

	if _, ok := ResolveAnnotationPath(token, hash); ok {
		t.Fatalf("expected resolve to fail without annotations dir")
	}
}

func setConnStateForTest(token string, state *connState) func() {
	connectionsMu.Lock()
	previous, existed := connections[token]
	connections[token] = state
	connectionsMu.Unlock()
	return func() {
		connectionsMu.Lock()
		defer connectionsMu.Unlock()
		if existed {
			connections[token] = previous
			return
		}
		delete(connections, token)
	}
}

func TestMergeAnnotationFiles_AddNewMask(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1}},
	}
	incoming := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1}, {ID: 2, ImageID: 1, Keypoints: []float64{2, 2, 2}, NumKeypoints: 1}},
	}
	got := mergeAnnotationFiles(existing, incoming)
	if len(got.Annotations) != 2 {
		t.Fatalf("expected two annotations, got %#v", got.Annotations)
	}
}

func TestMergeAnnotationFiles_UpdateExistingMask(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1}},
	}
	incoming := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{{ID: 1, ImageID: 1, Keypoints: []float64{9, 9, 2}, NumKeypoints: 1}},
	}
	got := mergeAnnotationFiles(existing, incoming)
	if len(got.Annotations) != 1 {
		t.Fatalf("expected one annotation, got %#v", got.Annotations)
	}
	if !reflect.DeepEqual(got.Annotations[0].Keypoints, []float64{9, 9, 2}) {
		t.Fatalf("expected updated keypoint, got %#v", got.Annotations[0].Keypoints)
	}
}

func TestMergeAnnotationFiles_RemoveMask(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1},
			{ID: 2, ImageID: 1, Keypoints: []float64{2, 2, 2}, NumKeypoints: 1},
		},
	}
	incoming := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1}},
	}
	got := mergeAnnotationFiles(existing, incoming)
	if len(got.Annotations) != 1 || got.Annotations[0].ID != 1 {
		t.Fatalf("expected only id=1 to remain, got %#v", got.Annotations)
	}
}

func TestMergeAnnotationFiles_PreservesOtherImageAnnotations(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1}, {ID: 2}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1},
			{ID: 9, ImageID: 2, Keypoints: []float64{3, 3, 2}, NumKeypoints: 1},
		},
	}
	incoming := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{{ID: 1, ImageID: 1, Keypoints: []float64{5, 5, 2}, NumKeypoints: 1}},
	}
	got := mergeAnnotationFiles(existing, incoming)
	if len(got.Annotations) != 2 {
		t.Fatalf("expected two annotations, got %#v", got.Annotations)
	}
	foundImage2 := false
	for _, ann := range got.Annotations {
		if ann.ImageID == 2 && ann.ID == 9 {
			foundImage2 = true
		}
	}
	if !foundImage2 {
		t.Fatalf("expected image_id=2 annotation to survive, got %#v", got.Annotations)
	}
}

func TestMergeAnnotationFiles_CategoryMergeSorted(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Categories:  []annotations.CocoCategory{{ID: 1, Name: "A"}},
		Annotations: []annotations.CocoAnnotation{},
	}
	incoming := &annotations.AnnotationFile{
		Images:      []annotations.CocoImage{{ID: 1}},
		Categories:  []annotations.CocoCategory{{ID: 2, Name: "B"}},
		Annotations: []annotations.CocoAnnotation{},
	}
	got := mergeAnnotationFiles(existing, incoming)
	if len(got.Categories) != 2 {
		t.Fatalf("expected two categories, got %#v", got.Categories)
	}
	if got.Categories[0].ID != 1 || got.Categories[1].ID != 2 {
		t.Fatalf("expected categories sorted by id, got %#v", got.Categories)
	}
}

func TestMergeAnnotationFiles_SidecarUpdate(t *testing.T) {
	existing := &annotations.AnnotationFile{
		NemolabLabels: json.RawMessage(`{"old":1}`),
	}
	incoming := &annotations.AnnotationFile{
		NemolabLabels: json.RawMessage(`{"new":2}`),
	}
	got := mergeAnnotationFiles(existing, incoming)
	if string(got.NemolabLabels) != `{"new":2}` {
		t.Fatalf("expected incoming sidecar to win, got %s", string(got.NemolabLabels))
	}
}

func TestMergeAnnotationFiles_SidecarPreservedWhenIncomingNil(t *testing.T) {
	existing := &annotations.AnnotationFile{
		NemolabLabels: json.RawMessage(`{"old":1}`),
	}
	incoming := &annotations.AnnotationFile{}
	got := mergeAnnotationFiles(existing, incoming)
	if string(got.NemolabLabels) != `{"old":1}` {
		t.Fatalf("expected existing sidecar to be preserved, got %s", string(got.NemolabLabels))
	}
}

func TestMergeAnnotationFiles_PreservesImageHashFieldsWhenIncomingMissing(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{
			ID:                1,
			FileName:          "img.png",
			Width:             10,
			Height:            10,
			NemolabHashSHA256: "cafebabe",
			NemolabHashAlgo:   "sha256",
		}},
	}
	incoming := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{
			ID:       1,
			FileName: "img.png",
			Width:    20,
			Height:   20,
		}},
	}

	got := mergeAnnotationFiles(existing, incoming)
	if len(got.Images) != 1 {
		t.Fatalf("expected one image, got %#v", got.Images)
	}
	if got.Images[0].NemolabHashSHA256 != "cafebabe" || got.Images[0].NemolabHashAlgo != "sha256" {
		t.Fatalf("expected hash fields to be preserved, got %#v", got.Images[0])
	}
}

func TestFindImageIndexByPath(t *testing.T) {
	images := []annotations.CocoImage{
		{ID: 1, FileName: "a.png"},
		{ID: 2, FileName: "b.png"},
	}
	if got := findImageIndexByPath(images, "/tmp/x/b.png"); got != 1 {
		t.Fatalf("expected basename match index=1, got %d", got)
	}
	if got := findImageIndexByPath(images, "/tmp/x/c.png"); got != -1 {
		t.Fatalf("expected no match, got %d", got)
	}
}

func TestApplyCommentAuthorUpdate_ChangedCommentSetsAuthor(t *testing.T) {
	existing := &annotations.AnnotationFile{
		NemolabComments: json.RawMessage(`{"image":"old"}`),
		NemolabAuthors:  json.RawMessage(`{"image":"alice"}`),
	}
	incoming := &annotations.AnnotationFile{
		NemolabComments: json.RawMessage(`{"image":"new"}`),
		NemolabAuthors:  json.RawMessage(`{"image":"alice"}`),
	}

	applyCommentAuthorUpdate(existing, incoming, "bob")

	if got := decodeStringMap(incoming.NemolabComments)["image"]; got != "new" {
		t.Fatalf("expected updated comment, got %q", got)
	}
	if got := decodeStringMap(incoming.NemolabAuthors)["image"]; got != "bob" {
		t.Fatalf("expected author update to bob, got %q", got)
	}
}

func TestApplyCommentAuthorUpdate_RemovedCommentClearsAuthor(t *testing.T) {
	existing := &annotations.AnnotationFile{
		NemolabComments: json.RawMessage(`{"42":"needs review"}`),
		NemolabAuthors:  json.RawMessage(`{"42":"alice"}`),
	}
	incoming := &annotations.AnnotationFile{
		NemolabComments: json.RawMessage(`{}`),
		NemolabAuthors:  json.RawMessage(`{"42":"alice"}`),
	}

	applyCommentAuthorUpdate(existing, incoming, "bob")

	if got := decodeStringMap(incoming.NemolabComments)["42"]; got != "" {
		t.Fatalf("expected comment key removed, got %q", got)
	}
	if got := decodeStringMap(incoming.NemolabAuthors)["42"]; got != "" {
		t.Fatalf("expected author key removed, got %q", got)
	}
}

func TestApplyCommentAuthorUpdate_UnchangedCommentKeepsAuthor(t *testing.T) {
	existing := &annotations.AnnotationFile{
		NemolabComments: json.RawMessage(`{"42":"stable"}`),
		NemolabAuthors:  json.RawMessage(`{"42":"alice"}`),
	}
	incoming := &annotations.AnnotationFile{
		NemolabComments: json.RawMessage(`{"42":"stable"}`),
		NemolabAuthors:  json.RawMessage(`{}`),
	}

	applyCommentAuthorUpdate(existing, incoming, "bob")

	if got := decodeStringMap(incoming.NemolabAuthors)["42"]; got != "alice" {
		t.Fatalf("expected unchanged comment to keep existing author, got %q", got)
	}
}

func TestApplyMaskAuthorUpdate_NewMaskSetsAuthor(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images:             []annotations.CocoImage{{ID: 1}},
		Annotations:        []annotations.CocoAnnotation{{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1}},
		NemolabMaskAuthors: json.RawMessage(`{"1":"alice"}`),
	}
	incoming := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1},
			{ID: 2, ImageID: 1, Keypoints: []float64{2, 2, 2}, NumKeypoints: 1},
		},
	}

	applyMaskAuthorUpdate(existing, incoming, "bob")

	authors := decodeStringMap(incoming.NemolabMaskAuthors)
	if got := authors["1"]; got != "alice" {
		t.Fatalf("expected unchanged mask author to stay alice, got %q", got)
	}
	if got := authors["2"]; got != "bob" {
		t.Fatalf("expected new mask author to be bob, got %q", got)
	}
}

func TestApplyMaskAuthorUpdate_ChangedMaskOverwritesAuthor(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 7, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1, CategoryID: 1},
		},
		NemolabMaskAuthors: json.RawMessage(`{"7":"alice"}`),
	}
	incoming := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 7, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1, CategoryID: 2},
		},
	}

	applyMaskAuthorUpdate(existing, incoming, "bob")

	if got := decodeStringMap(incoming.NemolabMaskAuthors)["7"]; got != "bob" {
		t.Fatalf("expected changed mask author to be overwritten to bob, got %q", got)
	}
}

func TestApplyMaskAuthorUpdate_RemovedMaskClearsAuthor(t *testing.T) {
	existing := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1},
			{ID: 2, ImageID: 1, Keypoints: []float64{2, 2, 2}, NumKeypoints: 1},
		},
		NemolabMaskAuthors: json.RawMessage(`{"1":"alice","2":"alice"}`),
	}
	incoming := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 1, ImageID: 1, Keypoints: []float64{1, 1, 2}, NumKeypoints: 1},
		},
	}

	applyMaskAuthorUpdate(existing, incoming, "bob")

	authors := decodeStringMap(incoming.NemolabMaskAuthors)
	if got := authors["1"]; got != "alice" {
		t.Fatalf("expected retained mask author to stay alice, got %q", got)
	}
	if got := authors["2"]; got != "" {
		t.Fatalf("expected removed mask author to be cleared, got %q", got)
	}
}

func TestMigrateAnnotationFileIfNeeded_NoOpWhenTargetExists(t *testing.T) {
	dir := t.TempDir()
	imagePath := filepath.Join(dir, "img.png")
	target := filepath.Join(dir, "nemolab.json")
	other := filepath.Join(dir, "img.json")
	writeAnnotationFixture(t, target, "target.png")
	writeAnnotationFixture(t, other, "other.png")

	if err := migrateAnnotationFileIfNeeded("test-token", target, dir, true, imagePath); err != nil {
		t.Fatalf("migrate failed: %v", err)
	}
	af, err := annotations.ReadAnnotations(target)
	if err != nil {
		t.Fatalf("read target failed: %v", err)
	}
	if len(af.Images) == 0 || af.Images[0].FileName != "target.png" {
		t.Fatalf("expected target to stay unchanged, got %#v", af.Images)
	}
}

func TestMigrateAnnotationFileIfNeeded_NoOpWhenNeitherExists(t *testing.T) {
	dir := t.TempDir()
	imagePath := filepath.Join(dir, "img.png")
	target := filepath.Join(dir, "nemolab.json")
	if err := migrateAnnotationFileIfNeeded("test-token", target, dir, true, imagePath); err != nil {
		t.Fatalf("migrate failed: %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("expected no target file created, stat err=%v", err)
	}
}

func TestMigrateAnnotationFileIfNeeded_PerImageToSingleFile(t *testing.T) {
	dir := t.TempDir()
	imagePath := filepath.Join(dir, "img.png")
	perImage := filepath.Join(dir, "img.json")
	target := filepath.Join(dir, "nemolab.json")
	writeAnnotationFixture(t, perImage, "migrate.png")

	if err := migrateAnnotationFileIfNeeded("test-token", target, dir, true, imagePath); err != nil {
		t.Fatalf("migrate failed: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("expected target to exist: %v", err)
	}
	if _, err := os.Stat(perImage); !os.IsNotExist(err) {
		t.Fatalf("expected old per-image file removed, stat err=%v", err)
	}
}

func TestMigrateAnnotationFileIfNeeded_SingleFileToPerImage(t *testing.T) {
	dir := t.TempDir()
	imagePath := filepath.Join(dir, "img.png")
	single := filepath.Join(dir, "nemolab.json")
	target := filepath.Join(dir, "img.json")
	writeAnnotationFixture(t, single, "migrate2.png")

	if err := migrateAnnotationFileIfNeeded("test-token", target, dir, false, imagePath); err != nil {
		t.Fatalf("migrate failed: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("expected per-image target to exist: %v", err)
	}
	if _, err := os.Stat(single); !os.IsNotExist(err) {
		t.Fatalf("expected old single-file removed, stat err=%v", err)
	}
}

func writeAnnotationFixture(t *testing.T, path, fileName string) {
	t.Helper()
	af := &annotations.AnnotationFile{
		Images: []annotations.CocoImage{{ID: 1, FileName: fileName, Width: 10, Height: 10}},
		Annotations: []annotations.CocoAnnotation{
			{ID: 1, ImageID: 1, Keypoints: []float64{1, 2, 2}, NumKeypoints: 1},
		},
		Categories: []annotations.CocoCategory{{ID: 1, Name: "A"}},
	}
	if err := annotations.WriteAnnotations(path, af); err != nil {
		t.Fatalf("write fixture failed: %v", err)
	}
}
