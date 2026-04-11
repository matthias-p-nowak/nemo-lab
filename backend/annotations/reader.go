package annotations

import (
	"encoding/json"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"slices"

	"golang.org/x/image/vector"
)

// ReadAnnotations reads one annotation file and normalizes it to AnnotationFile.
func ReadAnnotations(path string) (*AnnotationFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, fmt.Errorf("parse annotation json: %w", err)
	}

	if _, ok := top["shapes"]; ok {
		return parseLabelMe(path, top)
	}
	return parseCOCO(top)
}

func parseCOCO(top map[string]json.RawMessage) (*AnnotationFile, error) {
	af := &AnnotationFile{}
	if err := decodeSlice(top["images"], &af.Images); err != nil {
		return nil, fmt.Errorf("parse images: %w", err)
	}
	if err := decodeSlice(top["annotations"], &af.Annotations); err != nil {
		return nil, fmt.Errorf("parse annotations: %w", err)
	}
	if err := decodeSlice(top["categories"], &af.Categories); err != nil {
		return nil, fmt.Errorf("parse categories: %w", err)
	}
	af.NemolabLabels = cloneRaw(top["nemolab_labels"])
	af.NemolabComments = cloneRaw(top["nemolab_comments"])
	af.NemolabAuthors = cloneRaw(top["nemolab_authors"])

	imgSizeByID := map[int][2]int{}
	for _, img := range af.Images {
		imgSizeByID[img.ID] = [2]int{img.Width, img.Height}
	}
	for i := range af.Annotations {
		seg := af.Annotations[i].Segmentation
		if !isPolygonSegmentation(seg) {
			continue
		}
		size, ok := imgSizeByID[af.Annotations[i].ImageID]
		if !ok || size[0] <= 0 || size[1] <= 0 {
			return nil, fmt.Errorf("polygon segmentation without image dimensions: image_id=%d", af.Annotations[i].ImageID)
		}
		rle, area, err := polygonSegmentationToRLE(seg, size[1], size[0])
		if err != nil {
			return nil, fmt.Errorf("rasterize coco polygon annotation id=%d: %w", af.Annotations[i].ID, err)
		}
		af.Annotations[i].Segmentation = rle
		af.Annotations[i].Area = area
	}
	return af, nil
}

type labelMeShape struct {
	Label     string      `json:"label"`
	ShapeType string      `json:"shape_type"`
	Points    [][]float64 `json:"points"`
}

type labelMeTop struct {
	ImagePath   string         `json:"imagePath"`
	ImageWidth  int            `json:"imageWidth"`
	ImageHeight int            `json:"imageHeight"`
	Shapes      []labelMeShape `json:"shapes"`
}

func parseLabelMe(path string, top map[string]json.RawMessage) (*AnnotationFile, error) {
	var lm labelMeTop
	joined, err := json.Marshal(top)
	if err != nil {
		return nil, fmt.Errorf("rebuild labelme object: %w", err)
	}
	if err := json.Unmarshal(joined, &lm); err != nil {
		return nil, fmt.Errorf("parse labelme: %w", err)
	}

	fileName := lm.ImagePath
	if fileName == "" {
		fileName = filepath.Base(path)
	}

	af := &AnnotationFile{
		Images: []CocoImage{{
			ID:       1,
			FileName: fileName,
			Width:    lm.ImageWidth,
			Height:   lm.ImageHeight,
		}},
		Annotations: []CocoAnnotation{},
		Categories:  []CocoCategory{},
	}

	categoryIDByName := map[string]int{}
	nextCategoryID := 1
	nextAnnotationID := 1
	for _, shape := range lm.Shapes {
		name := shape.Label
		if name == "" {
			name = "unlabeled"
		}
		catID, ok := categoryIDByName[name]
		if !ok {
			catID = nextCategoryID
			nextCategoryID++
			categoryIDByName[name] = catID
			af.Categories = append(af.Categories, CocoCategory{ID: catID, Name: name})
		}
		ann := CocoAnnotation{
			ID:         nextAnnotationID,
			ImageID:    1,
			CategoryID: catID,
			Iscrowd:    0,
		}
		nextAnnotationID++

		shapeType := shape.ShapeType
		if shapeType == "" {
			if len(shape.Points) >= 3 {
				shapeType = "polygon"
			} else if len(shape.Points) == 1 {
				shapeType = "point"
			}
		}

		switch shapeType {
		case "polygon":
			rle, area, err := polygonPointsToRLE(shape.Points, lm.ImageHeight, lm.ImageWidth)
			if err != nil {
				return nil, fmt.Errorf("rasterize labelme polygon id=%d: %w", ann.ID, err)
			}
			ann.Segmentation = rle
			ann.Area = area
		case "point":
			if len(shape.Points) >= 1 && len(shape.Points[0]) >= 2 {
				ann.Keypoints = []float64{shape.Points[0][0], shape.Points[0][1], 2}
				ann.NumKeypoints = 1
			}
		case "rectangle":
			if len(shape.Points) >= 2 && len(shape.Points[0]) >= 2 && len(shape.Points[1]) >= 2 {
				x0 := minFloat(shape.Points[0][0], shape.Points[1][0])
				y0 := minFloat(shape.Points[0][1], shape.Points[1][1])
				x1 := maxFloat(shape.Points[0][0], shape.Points[1][0])
				y1 := maxFloat(shape.Points[0][1], shape.Points[1][1])
				ann.BBox = []float64{x0, y0, x1 - x0, y1 - y0}
				ann.Area = ann.BBox[2] * ann.BBox[3]
			}
		}
		af.Annotations = append(af.Annotations, ann)
	}
	return af, nil
}

func isPolygonSegmentation(seg any) bool {
	parts, ok := seg.([]any)
	if !ok || len(parts) == 0 {
		return false
	}
	_, ok = parts[0].([]any)
	return ok
}

func polygonSegmentationToRLE(seg any, height, width int) (CocoRLE, float64, error) {
	partsAny := seg.([]any)
	polygons := make([][]float64, 0, len(partsAny))
	for _, part := range partsAny {
		rawPoints, ok := part.([]any)
		if !ok {
			return CocoRLE{}, 0, fmt.Errorf("invalid polygon component")
		}
		points := make([]float64, 0, len(rawPoints))
		for _, p := range rawPoints {
			v, ok := p.(float64)
			if !ok {
				return CocoRLE{}, 0, fmt.Errorf("polygon coordinate is not number")
			}
			points = append(points, v)
		}
		polygons = append(polygons, points)
	}
	return polygonsToRLE(polygons, height, width)
}

func polygonPointsToRLE(points [][]float64, height, width int) (CocoRLE, float64, error) {
	if len(points) < 3 {
		return CocoRLE{}, 0, fmt.Errorf("polygon requires at least 3 points")
	}
	flat := make([]float64, 0, len(points)*2)
	for _, p := range points {
		if len(p) < 2 {
			return CocoRLE{}, 0, fmt.Errorf("polygon point must have x,y")
		}
		flat = append(flat, p[0], p[1])
	}
	return polygonsToRLE([][]float64{flat}, height, width)
}

func polygonsToRLE(polygons [][]float64, height, width int) (CocoRLE, float64, error) {
	if height <= 0 || width <= 0 {
		return CocoRLE{}, 0, fmt.Errorf("invalid image size %dx%d", width, height)
	}
	mask := image.NewAlpha(image.Rect(0, 0, width, height))
	ras := vector.NewRasterizer(width, height)
	for _, poly := range polygons {
		if len(poly) < 6 || len(poly)%2 != 0 {
			continue
		}
		ras.Reset(width, height)
		ras.MoveTo(float32(poly[0]), float32(poly[1]))
		for i := 2; i < len(poly); i += 2 {
			ras.LineTo(float32(poly[i]), float32(poly[i+1]))
		}
		ras.ClosePath()
		ras.Draw(mask, mask.Bounds(), image.Opaque, image.Point{})
	}
	counts, ones := alphaMaskToColumnMajorRLE(mask)
	return CocoRLE{Size: []int{height, width}, Counts: counts}, float64(ones), nil
}

func alphaMaskToColumnMajorRLE(mask *image.Alpha) ([]int, int) {
	counts := make([]int, 0, 1024)
	current := 0 // 0 background, 1 foreground
	run := 0
	ones := 0
	for x := 0; x < mask.Rect.Dx(); x++ {
		for y := 0; y < mask.Rect.Dy(); y++ {
			v := 0
			if mask.AlphaAt(mask.Rect.Min.X+x, mask.Rect.Min.Y+y).A > 0 {
				v = 1
				ones++
			}
			if v == current {
				run++
				continue
			}
			counts = append(counts, run)
			run = 1
			current = v
		}
	}
	counts = append(counts, run)
	return counts, ones
}

func decodeSlice[T any](raw json.RawMessage, out *[]T) error {
	if len(raw) == 0 || string(raw) == "null" {
		*out = []T{}
		return nil
	}
	var arr []T
	if err := json.Unmarshal(raw, &arr); err != nil {
		return err
	}
	if arr == nil {
		arr = []T{}
	}
	*out = arr
	return nil
}

func cloneRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return slices.Clone(raw)
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
