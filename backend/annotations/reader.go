package annotations

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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

	for i := range af.Annotations {
		seg := af.Annotations[i].Segmentation
		if seg == nil {
			continue
		}
		if isPolygonSegmentation(seg) {
			area, err := polygonSegmentationArea(seg)
			if err != nil {
				return nil, fmt.Errorf("compute coco polygon area annotation id=%d: %w", af.Annotations[i].ID, err)
			}
			af.Annotations[i].Area = area
			continue
		}

		rle, ok, err := asCocoRLE(seg)
		if err != nil {
			return nil, fmt.Errorf("parse coco rle annotation id=%d: %w", af.Annotations[i].ID, err)
		}
		if !ok {
			continue
		}
		poly, err := rleToContourPolygon(rle)
		if err != nil {
			return nil, fmt.Errorf("convert coco rle annotation id=%d to contour polygon: %w", af.Annotations[i].ID, err)
		}
		af.Annotations[i].Segmentation = []any{floatSliceToAnySlice(poly)}
		af.Annotations[i].Area = polygonArea(poly)
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
			flat, err := flattenLabelMePolygonPoints(shape.Points)
			if err != nil {
				return nil, fmt.Errorf("convert labelme polygon id=%d: %w", ann.ID, err)
			}
			ann.Segmentation = []any{floatSliceToAnySlice(flat)}
			ann.Area = polygonArea(flat)
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

func polygonSegmentationArea(seg any) (float64, error) {
	partsAny := seg.([]any)
	total := 0.0
	for _, part := range partsAny {
		rawPoints, ok := part.([]any)
		if !ok {
			return 0, fmt.Errorf("invalid polygon component")
		}
		points := make([]float64, 0, len(rawPoints))
		for _, p := range rawPoints {
			v, ok := p.(float64)
			if !ok {
				return 0, fmt.Errorf("polygon coordinate is not number")
			}
			points = append(points, v)
		}
		total += polygonArea(points)
	}
	return total, nil
}

func flattenLabelMePolygonPoints(points [][]float64) ([]float64, error) {
	if len(points) < 3 {
		return nil, fmt.Errorf("polygon requires at least 3 points")
	}
	flat := make([]float64, 0, len(points)*2)
	for _, p := range points {
		if len(p) < 2 {
			return nil, fmt.Errorf("polygon point must have x,y")
		}
		flat = append(flat, p[0], p[1])
	}
	return flat, nil
}

func asCocoRLE(seg any) (CocoRLE, bool, error) {
	switch typed := seg.(type) {
	case CocoRLE:
		return typed, true, nil
	case map[string]any:
		sizeRaw, ok := typed["size"]
		if !ok {
			return CocoRLE{}, false, nil
		}
		countsRaw, ok := typed["counts"]
		if !ok {
			return CocoRLE{}, false, nil
		}
		sizeAny, ok := sizeRaw.([]any)
		if !ok || len(sizeAny) < 2 {
			return CocoRLE{}, false, fmt.Errorf("invalid rle size")
		}
		size := make([]int, 2)
		for i := 0; i < 2; i++ {
			v, ok := sizeAny[i].(float64)
			if !ok {
				return CocoRLE{}, false, fmt.Errorf("invalid rle size component")
			}
			size[i] = int(v)
		}
		return CocoRLE{Size: size, Counts: countsRaw}, true, nil
	default:
		return CocoRLE{}, false, nil
	}
}

func floatSliceToAnySlice(in []float64) []any {
	out := make([]any, 0, len(in))
	for _, v := range in {
		out = append(out, v)
	}
	return out
}

func decodeUncompressedRLECounts(counts any) ([]int, error) {
	switch typed := counts.(type) {
	case []int:
		return typed, nil
	case []float64:
		out := make([]int, 0, len(typed))
		for _, v := range typed {
			out = append(out, int(v))
		}
		return out, nil
	case []any:
		out := make([]int, 0, len(typed))
		for _, v := range typed {
			switch x := v.(type) {
			case float64:
				out = append(out, int(x))
			case int:
				out = append(out, x)
			default:
				return nil, fmt.Errorf("rle count has non-numeric value")
			}
		}
		return out, nil
	case string:
		return nil, fmt.Errorf("compressed rle counts are not supported")
	default:
		return nil, fmt.Errorf("invalid rle counts type %T", counts)
	}
}

func decodeColumnMajorMaskFromRLE(rle CocoRLE) ([][]bool, error) {
	if len(rle.Size) < 2 {
		return nil, fmt.Errorf("rle size must have 2 entries")
	}
	height := rle.Size[0]
	width := rle.Size[1]
	if height <= 0 || width <= 0 {
		return nil, fmt.Errorf("invalid rle size %dx%d", width, height)
	}
	counts, err := decodeUncompressedRLECounts(rle.Counts)
	if err != nil {
		return nil, err
	}
	total := width * height
	flat := make([]bool, total)
	pos := 0
	value := 0
	for _, run := range counts {
		if run < 0 {
			return nil, fmt.Errorf("negative rle run")
		}
		if pos+run > total {
			return nil, fmt.Errorf("rle run exceeds mask size")
		}
		if value == 1 {
			for i := pos; i < pos+run; i++ {
				flat[i] = true
			}
		}
		pos += run
		value = 1 - value
	}
	if pos != total {
		return nil, fmt.Errorf("rle runs (%d) do not cover mask size (%d)", pos, total)
	}
	mask := make([][]bool, height)
	for y := 0; y < height; y++ {
		mask[y] = make([]bool, width)
	}
	for idx, on := range flat {
		if !on {
			continue
		}
		x := idx / height
		y := idx % height
		mask[y][x] = true
	}
	return mask, nil
}

type intPoint struct {
	X int
	Y int
}

type intEdge struct {
	A intPoint
	B intPoint
}

func edgeKey(a, b intPoint) string {
	if a.X < b.X || (a.X == b.X && a.Y <= b.Y) {
		return fmt.Sprintf("%d,%d|%d,%d", a.X, a.Y, b.X, b.Y)
	}
	return fmt.Sprintf("%d,%d|%d,%d", b.X, b.Y, a.X, a.Y)
}

func appendBoundaryEdge(edges map[string]intEdge, a, b intPoint) {
	key := edgeKey(a, b)
	if _, exists := edges[key]; exists {
		delete(edges, key)
		return
	}
	edges[key] = intEdge{A: a, B: b}
}

func boundaryLoopsFromMask(mask [][]bool) [][]intPoint {
	height := len(mask)
	if height == 0 {
		return nil
	}
	width := len(mask[0])
	edges := map[string]intEdge{}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			if !mask[y][x] {
				continue
			}
			p00 := intPoint{X: x, Y: y}
			p10 := intPoint{X: x + 1, Y: y}
			p11 := intPoint{X: x + 1, Y: y + 1}
			p01 := intPoint{X: x, Y: y + 1}
			appendBoundaryEdge(edges, p00, p10)
			appendBoundaryEdge(edges, p10, p11)
			appendBoundaryEdge(edges, p11, p01)
			appendBoundaryEdge(edges, p01, p00)
		}
	}
	if len(edges) == 0 {
		return nil
	}
	adj := map[intPoint][]intPoint{}
	for _, edge := range edges {
		adj[edge.A] = append(adj[edge.A], edge.B)
		adj[edge.B] = append(adj[edge.B], edge.A)
	}
	remaining := map[string]struct{}{}
	for _, edge := range edges {
		remaining[edgeKey(edge.A, edge.B)] = struct{}{}
	}
	loops := [][]intPoint{}
	for len(remaining) > 0 {
		var startA, startB intPoint
		for _, edge := range edges {
			key := edgeKey(edge.A, edge.B)
			if _, ok := remaining[key]; ok {
				startA, startB = edge.A, edge.B
				break
			}
		}
		loop := []intPoint{startA, startB}
		delete(remaining, edgeKey(startA, startB))
		prev := startA
		curr := startB
		for {
			neighbors := adj[curr]
			if len(neighbors) == 0 {
				break
			}
			next := neighbors[0]
			if len(neighbors) > 1 && next == prev {
				next = neighbors[1]
			}
			if next == startA {
				loops = append(loops, loop)
				break
			}
			delete(remaining, edgeKey(curr, next))
			loop = append(loop, next)
			prev, curr = curr, next
			if len(loop) > len(edges)+2 {
				break
			}
		}
	}
	return loops
}

func rleToContourPolygon(rle CocoRLE) ([]float64, error) {
	mask, err := decodeColumnMajorMaskFromRLE(rle)
	if err != nil {
		return nil, err
	}
	loops := boundaryLoopsFromMask(mask)
	if len(loops) == 0 {
		return nil, fmt.Errorf("mask has no foreground contour")
	}
	var best []float64
	bestArea := 0.0
	for _, loop := range loops {
		if len(loop) < 3 {
			continue
		}
		flat := make([]float64, 0, len(loop)*2)
		for _, p := range loop {
			flat = append(flat, float64(p.X), float64(p.Y))
		}
		area := polygonArea(flat)
		if area <= bestArea {
			continue
		}
		bestArea = area
		best = flat
	}
	if len(best) < 6 {
		return nil, fmt.Errorf("failed to extract valid contour polygon")
	}
	return best, nil
}

func polygonArea(flat []float64) float64 {
	if len(flat) < 6 || len(flat)%2 != 0 {
		return 0
	}
	n := len(flat) / 2
	acc := 0.0
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		x0 := flat[2*i]
		y0 := flat[2*i+1]
		x1 := flat[2*j]
		y1 := flat[2*j+1]
		acc += x0*y1 - x1*y0
	}
	if acc < 0 {
		acc = -acc
	}
	return acc * 0.5
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
