package annotations

import "encoding/json"

// AnnotationFile is the unified in-memory representation used by reader/writer.
type AnnotationFile struct {
	Images      []CocoImage      `json:"images"`
	Annotations []CocoAnnotation `json:"annotations"`
	Categories  []CocoCategory   `json:"categories"`

	NemolabLabels   json.RawMessage `json:"nemolab_labels,omitempty"`
	NemolabComments json.RawMessage `json:"nemolab_comments,omitempty"`
	NemolabAuthors  json.RawMessage `json:"nemolab_authors,omitempty"`
}

type CocoImage struct {
	ID       int    `json:"id"`
	FileName string `json:"file_name,omitempty"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
}

type CocoCategory struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// CocoRLE supports either compressed string counts or uncompressed []int.
type CocoRLE struct {
	Size   []int `json:"size"`
	Counts any   `json:"counts"`
}

type CocoAnnotation struct {
	ID           int       `json:"id"`
	ImageID      int       `json:"image_id"`
	CategoryID   int       `json:"category_id,omitempty"`
	BBox         []float64 `json:"bbox,omitempty"`
	Area         float64   `json:"area,omitempty"`
	Iscrowd      int       `json:"iscrowd,omitempty"`
	Keypoints    []float64 `json:"keypoints,omitempty"`
	NumKeypoints int       `json:"num_keypoints,omitempty"`
	Segmentation any       `json:"segmentation,omitempty"`
}
