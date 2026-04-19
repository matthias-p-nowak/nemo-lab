package annotations

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// WriteAnnotations writes one annotation file as extended COCO JSON atomically.
func WriteAnnotations(path string, af *AnnotationFile) error {
	if af == nil {
		return fmt.Errorf("annotation file is nil")
	}

	type outFile struct {
		Images             []CocoImage      `json:"images"`
		Annotations        []CocoAnnotation `json:"annotations"`
		Categories         []CocoCategory   `json:"categories"`
		NemolabLabels      json.RawMessage  `json:"nemolab_labels,omitempty"`
		NemolabComments    json.RawMessage  `json:"nemolab_comments,omitempty"`
		NemolabAuthors     json.RawMessage  `json:"nemolab_authors,omitempty"`
		NemolabMaskAuthors json.RawMessage  `json:"nemolab_mask_authors,omitempty"`
	}

	out := outFile{
		Images:             af.Images,
		Annotations:        af.Annotations,
		Categories:         af.Categories,
		NemolabLabels:      af.NemolabLabels,
		NemolabComments:    af.NemolabComments,
		NemolabAuthors:     af.NemolabAuthors,
		NemolabMaskAuthors: af.NemolabMaskAuthors,
	}

	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal annotation file: %w", err)
	}
	data = append(data, '\n')

	parent := filepath.Dir(path)
	if parent != "." && parent != "" {
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return fmt.Errorf("create parent dirs: %w", err)
		}
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write temp annotation file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("rename temp annotation file: %w", err)
	}
	return nil
}
