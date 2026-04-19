from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from PyQt6.QtCore import QPointF, Qt
from PyQt6.QtGui import QColor, QKeyEvent, QPainterPath, QPen, QPolygonF
from PyQt6.QtWidgets import QApplication, QGraphicsScene, QGraphicsView, QMainWindow
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, split, unary_union

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("freehand_trial")


@dataclass
class TrialConfig:
    """Mutable tuning values for freehand trial behavior."""

    min_sample_distance_px: float = 3.0
    simplify_tolerance: float = 0.5
    max_self_intersection_segments: int = 3


class FreehandTrialScene(QGraphicsScene):
    """Scene that prototypes freehand annotation behaviors for refinement."""

    def __init__(self, config: TrialConfig, parent=None) -> None:
        super().__init__(parent)
        self.setSceneRect(0.0, 0.0, 1600.0, 1200.0)
        self.config = config
        self.stroke_pen = QPen(QColor(230, 60, 60), 2)
        self.loop_pen = QPen(QColor(40, 90, 220), 2)
        self.loop_brush = QColor(220, 40, 220, 80)
        self.start_point_brush = QColor(20, 190, 20)
        self.end_point_brush = QColor(220, 40, 40)
        self._stroke_points: list[QPointF] = []
        self._stroke_path = QPainterPath()
        self._stroke_item = None
        self._loop_polygons: list[Polygon] = []
        self._loop_items = []
        self._loop_marker_items = []
        self._record_seq = 0
        self._record_path = Path(__file__).resolve().parent / "freehand_trial.jsonl"

    def mousePressEvent(self, event) -> None:  # noqa: N802 (Qt override)
        self._stroke_points = [event.scenePos()]
        self._stroke_path = QPainterPath()
        self._stroke_path.moveTo(event.scenePos())
        if self._stroke_item is None:
            self._stroke_item = self.addPath(self._stroke_path, self.stroke_pen)
        else:
            self._stroke_item.setPath(self._stroke_path)
        event.accept()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if not self._stroke_points:
            super().mouseMoveEvent(event)
            return
        new_point = event.scenePos()
        if self._distance(self._stroke_points[-1], new_point) < self.config.min_sample_distance_px:
            event.accept()
            return
        self._stroke_points.append(new_point)
        self._stroke_path.lineTo(new_point)
        if self._stroke_item is not None:
            self._stroke_item.setPath(self._stroke_path)
        event.accept()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 (Qt override)
        seq = self._next_record_seq()
        pre_masks, pre_signatures = self._snapshot_masks()
        stroke_points = [[float(point.x()), float(point.y())] for point in self._stroke_points]
        stroke: LineString | None = None
        self_intersecting = False
        outcome = "no-op"
        if len(self._stroke_points) >= 2:
            stroke = LineString([(p.x(), p.y()) for p in self._stroke_points])
            self_intersecting = not stroke.is_simple
        self._append_jsonl(
            {
                "event": "stroke",
                "ts": self._utc_now_iso(),
                "seq": seq,
                "points": stroke_points,
                "self_intersecting": self_intersecting,
            }
        )
        if len(self._stroke_points) < 2:
            outcome = "stroke_too_short"
            self._write_result_event(seq, outcome, pre_signatures)
            self._clear_stroke_preview()
            return
        if stroke is None:
            outcome = "stroke_too_short"
            self._write_result_event(seq, outcome, pre_signatures)
            self._clear_stroke_preview()
            return
        if stroke.length < self.config.min_sample_distance_px:
            outcome = "below_min_distance"
            logger.info("Stroke rejected: below minimum sampled distance")
            self._write_result_event(seq, outcome, pre_signatures)
            self._clear_stroke_preview()
            return
        if stroke.is_simple:
            updated = self._apply_simple_stroke_edit(stroke)
            outcome = "updated" if updated else "no-op"
            logger.info("Simple stroke finalize result=%s", "updated" if updated else "no-op")
        else:
            created = self._apply_self_intersection_create(stroke)
            outcome = "created" if created else "no-op"
            logger.info("Self-intersecting stroke finalize result=%s", "created" if created else "no-op")
        self._write_result_event(seq, outcome, pre_signatures)
        self._redraw_loops()
        self._clear_stroke_preview()
        event.accept()

    def _next_record_seq(self) -> int:
        self._record_seq += 1
        return self._record_seq

    @staticmethod
    def _utc_now_iso() -> str:
        return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _append_jsonl(self, payload: dict) -> None:
        self._record_path.parent.mkdir(parents=True, exist_ok=True)
        with self._record_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False))
            fh.write("\n")

    @staticmethod
    def _polygon_points_for_record(polygon: Polygon) -> list[list[float]]:
        coords = list(polygon.exterior.coords)
        if len(coords) > 1 and coords[0] == coords[-1]:
            coords = coords[:-1]
        return [[float(x), float(y)] for x, y in coords]

    def _snapshot_masks(self) -> tuple[list[dict[str, list[list[float]]]], list[str]]:
        masks = []
        signatures: list[str] = []
        for polygon in self._loop_polygons:
            masks.append({"polygon": self._polygon_points_for_record(polygon)})
            signatures.append(polygon.wkt)
        return masks, signatures

    @staticmethod
    def _compute_mask_deltas(pre: list[str], post: list[str]) -> tuple[list[int], list[int], list[int]]:
        shared = min(len(pre), len(post))
        modified = [idx for idx in range(shared) if pre[idx] != post[idx]]
        created = list(range(len(pre), len(post))) if len(post) > len(pre) else []
        removed = list(range(len(post), len(pre))) if len(pre) > len(post) else []
        return created, modified, removed

    def _write_result_event(self, seq: int, outcome: str, pre_signatures: list[str]) -> None:
        masks, post_signatures = self._snapshot_masks()
        created, modified, removed = self._compute_mask_deltas(pre_signatures, post_signatures)
        self._append_jsonl(
            {
                "event": "result",
                "ts": self._utc_now_iso(),
                "seq": seq,
                "outcome": outcome,
                "masks": masks,
                "created_mask_indices": created,
                "modified_mask_indices": modified,
                "removed_mask_indices": removed,
            }
        )

    def _apply_self_intersection_create(self, stroke: LineString) -> bool:
        """Create one mask candidate from self-intersecting stroke with rejection rules."""
        merged = unary_union(stroke)
        segment_count = len(merged.geoms) if hasattr(merged, "geoms") else 1
        if segment_count > self.config.max_self_intersection_segments:
            logger.info("Rejected self-intersecting stroke: segment_count=%s > max=%s", segment_count, self.config.max_self_intersection_segments)
            return False
        loops = list(polygonize(merged))
        if not loops:
            return False
        chosen = max(loops, key=lambda poly: poly.area)
        self._loop_polygons.append(chosen.simplify(self.config.simplify_tolerance, preserve_topology=True))
        return True

    def _apply_simple_stroke_edit(self, stroke: LineString) -> bool:
        """Edit the loop with largest stroke-overlap using deterministic split/rejoin."""
        best_idx: int | None = None
        best_candidate: Polygon | None = None
        best_overlap = 0.0
        best_area = 0.0
        overlap_eps = 1e-9
        for idx, loop in enumerate(self._loop_polygons):
            overlap = self._stroke_overlap_with_loop_outline(loop, stroke)
            if overlap <= 0.0:
                continue
            candidate = self._edit_loop_with_stroke(loop, stroke)
            if candidate is None:
                continue
            area = float(loop.area)
            if best_idx is None or overlap > (best_overlap + overlap_eps):
                best_idx = idx
                best_candidate = candidate
                best_overlap = overlap
                best_area = area
                continue
            if abs(overlap - best_overlap) <= overlap_eps:
                # Tie-break for equal overlap: prefer larger loop area, then stable lowest index.
                if area > best_area or (area == best_area and idx < best_idx):
                    best_idx = idx
                    best_candidate = candidate
                    best_overlap = overlap
                    best_area = area
        if best_idx is None or best_candidate is None:
            return False
        self._loop_polygons[best_idx] = best_candidate
        return True

    def _edit_loop_with_stroke(self, loop: Polygon, stroke: LineString) -> Polygon | None:
        """Apply deterministic split/rejoin and keep largest valid resulting polygon."""
        outline = LineString(loop.exterior.coords)
        if not outline.intersects(stroke):
            return None
        try:
            outline_parts = [seg for seg in split(outline, stroke).geoms if seg.length > 0]
            stroke_parts = [seg for seg in split(stroke, outline).geoms if seg.length > 0]
        except Exception:
            return None
        if len(outline_parts) < 3 or len(stroke_parts) < 3:
            return None

        best: Polygon | None = None
        for replace_idx, _replace_part in enumerate(outline_parts):
            kept_outline = [seg for idx, seg in enumerate(outline_parts) if idx != replace_idx]
            for stroke_part in stroke_parts:
                merged = unary_union([*kept_outline, stroke_part])
                candidates = list(polygonize(merged))
                for candidate in candidates:
                    if best is None or candidate.area > best.area:
                        best = candidate
        if best is None:
            return None
        return best.simplify(self.config.simplify_tolerance, preserve_topology=True)

    @staticmethod
    def _stroke_overlap_with_loop_outline(loop: Polygon, stroke: LineString) -> float:
        """Return overlap score from stroke/outline intersection geometry."""
        outline = LineString(loop.exterior.coords)
        intersection = outline.intersection(stroke)
        if intersection.is_empty:
            return 0.0
        overlap_length = float(getattr(intersection, "length", 0.0))
        if overlap_length > 0.0:
            return overlap_length
        # Crossing cuts typically intersect at points (zero length); score by point count.
        return float(FreehandTrialScene._intersection_point_count(intersection))

    @staticmethod
    def _intersection_point_count(geometry) -> int:
        """Count point-like elements inside an intersection geometry recursively."""
        geom_type = geometry.geom_type
        if geom_type == "Point":
            return 1
        if geom_type in ("MultiPoint", "GeometryCollection", "MultiLineString", "MultiPolygon"):
            return sum(FreehandTrialScene._intersection_point_count(g) for g in geometry.geoms)
        # For unsupported types, treat as one hit if non-empty.
        return 1

    def _clear_stroke_preview(self) -> None:
        self._stroke_points = []
        self._stroke_path = QPainterPath()
        if self._stroke_item is not None:
            self.removeItem(self._stroke_item)
            self._stroke_item = None

    def _redraw_loops(self) -> None:
        for item in self._loop_items:
            self.removeItem(item)
        self._loop_items = []
        for item in self._loop_marker_items:
            self.removeItem(item)
        self._loop_marker_items = []
        for polygon in self._loop_polygons:
            coords = list(polygon.exterior.coords)
            qpoly = QPolygonF([QPointF(x, y) for x, y in coords])
            item = self.addPolygon(qpoly, self.loop_pen, self.loop_brush)
            self._loop_items.append(item)
            marker_size = self.loop_pen.widthF() * 3.0
            radius = marker_size / 2.0
            start_x, start_y = coords[0]
            end_x, end_y = coords[-2] if len(coords) > 1 else coords[0]
            start_marker = self.addEllipse(
                start_x - radius,
                start_y - radius,
                marker_size,
                marker_size,
                self.loop_pen,
                self.start_point_brush,
            )
            end_marker = self.addEllipse(
                end_x - radius,
                end_y - radius,
                marker_size,
                marker_size,
                self.loop_pen,
                self.end_point_brush,
            )
            self._loop_marker_items.extend([start_marker, end_marker])

    @staticmethod
    def _distance(a: QPointF, b: QPointF) -> float:
        dx = a.x() - b.x()
        dy = a.y() - b.y()
        return (dx * dx + dy * dy) ** 0.5


class TrialView(QGraphicsView):
    """Simple graphics view with right-drag panning and Ctrl-wheel zoom."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._pan_start = None
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)

    def wheelEvent(self, event) -> None:  # noqa: N802 (Qt override)
        delta = event.angleDelta().y()
        if delta == 0:
            return
        mods = event.modifiers()
        if mods & Qt.KeyboardModifier.ControlModifier:
            factor = 1.1 if delta > 0 else 0.9
            self.scale(factor, factor)
            event.accept()
            return
        super().wheelEvent(event)

    def mousePressEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if event.button() == Qt.MouseButton.RightButton:
            self._pan_start = event.position()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if self._pan_start is not None:
            pos = event.position()
            delta = pos - self._pan_start
            self._pan_start = pos
            self.horizontalScrollBar().setValue(int(self.horizontalScrollBar().value() - delta.x()))
            self.verticalScrollBar().setValue(int(self.verticalScrollBar().value() - delta.y()))
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 (Qt override)
        if event.button() == Qt.MouseButton.RightButton:
            self._pan_start = None
            self.setCursor(Qt.CursorShape.ArrowCursor)
            event.accept()
            return
        super().mouseReleaseEvent(event)


class TrialWindow(QMainWindow):
    """Window hosting freehand trial scene and keyboard tuning controls."""

    def __init__(self) -> None:
        super().__init__()
        self.config = TrialConfig()
        self.scene = FreehandTrialScene(self.config, self)
        self.view = TrialView(self)
        self.view.setScene(self.scene)
        self.setCentralWidget(self.view)
        self.resize(1200, 900)
        self._update_title()

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802 (Qt override)
        key = event.key()
        if key == Qt.Key.Key_BracketLeft:
            self.config.min_sample_distance_px = max(1.0, self.config.min_sample_distance_px - 1.0)
        elif key == Qt.Key.Key_BracketRight:
            self.config.min_sample_distance_px += 1.0
        elif key == Qt.Key.Key_Minus:
            self.config.simplify_tolerance = max(0.0, self.config.simplify_tolerance - 0.1)
        elif key == Qt.Key.Key_Equal:
            self.config.simplify_tolerance += 0.1
        elif key == Qt.Key.Key_C:
            self.scene._loop_polygons.clear()
            self.scene._redraw_loops()
        else:
            super().keyPressEvent(event)
            return
        self._update_title()
        event.accept()

    def _update_title(self) -> None:
        self.setWindowTitle(
            "Freehand Trial "
            f"(min_dist={self.config.min_sample_distance_px:.1f}px, "
            f"simplify={self.config.simplify_tolerance:.2f}, "
            "keys: [ ] dist, - = simplify, C clear)",
        )


def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    window = TrialWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
