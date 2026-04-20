# Requests

## Accepted decisions

- **Sessions in-memory**: Session tokens are stored in a server-side in-memory map; not persisted to SQLite. A server restart invalidates all sessions. (2026-04-02)

- **Auth flow**: Session cookie is set on successful login; WebSocket is then opened per tab using the cookie for auth. The WS serves as both communication channel and tab identity. (2026-04-02)

- **Tasks dialog admin/non-admin**: Fields description, images, annotations, and checkmark are read-only for non-admin users; browse buttons and delete/new-task actions are hidden. Admin mode is determined server-side; the badge in the dialog header reflects it. (2026-04-05)

- **Task card accordion**: Only one task card is expanded at a time in the Tasks dialog. (2026-04-05)

- **Checkmark field**: The task checkmark field represents "single annotation file 'nemolab.json'" — a boolean flag, not a file path. (2026-04-05)

- **Task persistence API**: Backend persists tasks, tags, and hierarchical labels in SQLite and serves them via `/api/tasks` endpoints. Non-admin users may edit only task `status` and `comment`; tag replacement is allowed for non-admin; task delete and label replacement are admin-only. (2026-04-05)

- **Tasks dialog load source**: Tasks dialog loads tasks from backend `GET /api/tasks` on open; UI ordering follows backend `ord` (with `id` tie-break). (2026-04-05)

- **Tasks dialog role source**: Tasks dialog admin/non-admin mode is sourced from backend `GET /api/me` (`is_admin`), not from local client toggles. (2026-04-05)

- **Frontend task persistence flow**: Task scalar edits, tag updates, label updates, create, and delete actions are sent to backend task endpoints immediately from the Tasks dialog. (2026-04-05)

- **Tasks dialog operation feedback**: Tasks dialog shows loading/saving state indicators and displays backend load/save failures as an inline error banner. (2026-04-05)

- **Task ordering persistence**: Admin users can reorder tasks in the dialog with up/down controls; frontend persists resulting order via updated `ord` values on task `PUT` calls. (2026-04-05)

- **Error banner lifecycle**: Tasks dialog inline error banners are cleared automatically after a subsequent successful load or save operation. (2026-04-05)

- **Task path directory browser**: In admin mode, browse buttons on task `images` and `annotations` open a directory-browser modal backed by `GET /api/dirs?path=...`; selecting a path applies it to the field and persists via the existing blur/save flow. (2026-04-05)

- **Optics transform toggles**: The Optics panel exposes three independent toggle controls (R = Rotate 90 CW, H = Horizontal flip, V = Vertical flip). Transforms compose in fixed order R→H→V. `PageUp`/`PageDown` cycles through all 8 transform states from a document-level key handler (except when focus is in `input`/`textarea`/`select`), and cycling updates the checkmarks. Panel-title reset clears all three toggles. (2026-04-06, clarified 2026-04-07)

- **Default label selection**: Label panel in right sidebar is a selector — clicking a row sets `activeLabelSelectedId` as the default for new masks. On task load, first leaf label is auto-selected. Label assignment via right-click context menu also updates the selection. (2026-04-07)

- **Mask selection**: Double-click selects a mask; Escape cancels selection; Arrow up/down cycle through masks (cycle includes "none selected"). Delete key removes the selected mask. Clicking an annotation row in the Annotations panel selects that mask. While a mask is selected, left-click placement is disabled (temporary restriction). In freehand mode, double-click hit-testing must run before drag capture so double-click near a mask never starts a stroke. Selecting a bbox mask promotes mode to `bounding box` so side-edit drag is immediately available. (2026-04-11, updated 2026-04-20)

- **Canvas keyboard shortcuts**: In canvas scope, `ArrowLeft`/`ArrowRight` navigate to previous/next image. Holding `Ctrl` temporarily hides all masks by suppressing the mask draw pass until key release (no persistent app-state change). (2026-04-20)

- **Annotation undo (limited history)**: In canvas scope, pressing `Backspace` undoes the latest annotation change for the current image. Undoable changes include mask create/remove, label assignment, bbox side edits, and freehand geometry edits. History depth is limited to 20 snapshots, cleared on image switch / fresh annotation payload load, and redo is not implemented. (2026-04-20)

- **Mask and label colors**: Two distinct palettes — fill uses mask index with S=0.50 V=0.70 (muted); outline uses label depth-first index with S=0.75 V=0.90 (vivid). Label colors are task-level stable. Default opacity: fill 40%, outline 100%. Unlabeled masks get `#888888` outline. No selection: all masks show fill+outline. With selection: selected mask shows fill+outline, others show outline only. (2026-04-11, updated 2026-04-11)

- **Mask rendering controls in Optics panel**: Four sliders — stroke opacity (0–1, default 1.0), fill opacity (0–1, default 0.4), stroke width (1–5 px, default 3 px), marker size (5–30 px, default 10 px). Outline drawn as ring (annulus); fill drawn as solid inner circle. Applied immediately via `applyOpticsToViewer()`, persisted as `mask_stroke_opacity`, `mask_fill_opacity`, `mask_stroke_width`, `mask_marker_size`. Reset by panel-title click. (2026-04-11)

- **Bounding box mask rendering**: Bbox annotations loaded from COCO `bbox` fields are rendered in the WebGL pass as filled rectangles with outlines, using the same fill/outline color, opacity, and selection rules as point masks. Coordinates are image-normalized. (2026-04-12)

- **render() focus preservation**: The `render()` function must save `document.activeElement` before rebuilding the DOM and restore focus to the matching element afterward. If the previously focused element no longer exists after render, focus is not restored. (2026-04-12)

- **Bounding box mask placement**: In `bounding box` mode, pressing the mouse button down and moving at least 10 CSS px begins drawing a new bbox; the rectangle updates live during drag and is finalized on mouse-up (opposite corner). Dragging less than 10 px is ignored. (2026-04-12)

- **Bounding box mask editing**: When exactly one mask is selected and it is a bounding box, dragging across any side of the rectangle (from either direction, inside or outside) moves that side to the pointer release position. Only side movement is supported (no corner resize, no whole-box drag). (2026-04-12)

- **Masks and annotations**: Point masks placed by left-click, removed by shift+left-click (closest within hit radius). Crosshair cursor on image view. Right-click within 10px of a mask opens context menu with recent labels; clicking assigns label to mask. This right-click behavior must work immediately after bbox placement gestures as well (no extra selection step required). Last assigned label auto-assigned to next mask. Logged to backend over WS (`mask_created`, `mask_removed`, `label_assigned`, `mouse_click`). Persistence deferred. (2026-04-07, updated 2026-04-20)

- **Annotation image-switch logging**: On image activation, frontend logs `image_activated` (full filename), `annotations_source` (source file path, annotation count, file format, annotation type summary) for each source file in both per-image and single-file modes, and `annotations_destination` (write target path). If no source file exists, no `annotations_source` is emitted. Annotation mutations (`mask_created`, `mask_removed`, `label_assigned`) are logged on every change. (2026-04-12)

- **Mask mode selector**: A dropdown panel between Labels and Masks in the right sidebar. Modes: `point` (left-click places point mask), `bounding box` (click-drag places rectangle), `freehand` (click-drag records pointer path as polygon). Per-mode description text is shown below the selector: point (`Click to annotate a location on the picture`), bounding box (`Draws a rectangle to indicate both location and size`), freehand (`Hand drawn mask without holes`). Active mode persists in `user_settings.annotation_mode` and is restored on startup; default remains `point` when unset. (2026-04-12, updated 2026-04-20)

- **Freehand mask drawing**: Shapely-based algorithm. Stroke points sampled at ≥3 px intervals. Self-intersecting strokes create a new loop (largest area from `polygonize`; rejected if >3 segments). Simple strokes edit the existing loop with highest stroke/outline overlap score (split/rejoin, keep largest polygon); near-endpoint closure (< 10 px) creates a new loop instead. All results simplified with tolerance 0.5 px. Live red stroke preview during drag. (2026-04-13)

- **Menu bar restructure**: Left and right sidebar toggles are always-visible fixed buttons. The hamburger + menu items form a middle section that is invisible and `pointer-events: none` when closed (mouse events pass through to canvas). Hamburger moves inside the menu bar middle section. (2026-04-07)

- **Left sidebar restructure**: Left sidebar mirrors right sidebar structure — scrollable content area with top margin to clear the two fixed buttons. Hamburger button is positioned adjacent to the left-sidebar toggle button (both top-left). Left sidebar content scrolls vertically (`overflow-y: auto`). (2026-04-12)

- **GUI cleanup**: Remove `<strong>` label text from both sidebar headers; remove `div.image-view__toolbar` entirely; fix hamburger/left-sidebar-toggle collision by moving hamburger to `left: 52px`. (2026-04-07)

- **Right sidebar resizable**: The right sidebar width is user-resizable via a drag handle on its left edge. Default `320px`, min `200px`. Width is persisted in `user_settings` as `sidebar_right_width`. Layout uses CSS variable `--sidebar-right-width`. Sidebar content scrolls vertically; panels expand to natural height. (2026-04-07)

- **User settings persistence**: UI preferences (theme, sidebar visibility, optics sliders and transform toggles, and mask annotation mode) are persisted per user in a `user_settings` SQLite table (one row per user_id + key, value as string). Exposed via `GET /api/settings` and `PUT /api/settings`. Frontend loads settings on page load and writes each setting immediately on change. Theme is no longer sourced from `nemo.toml`; default is `light`. (2026-04-07, updated 2026-04-20)

- **Multi-user annotation collaboration**: Backend holds one shared in-memory annotation store keyed by file path. Any user's change is merged per-mask (last write wins per mask id) and broadcast as full `annotations_data` to all other connections viewing the same file. Debounce write timer is per file path (shared). Pending dirty state is flushed on connection close. (2026-04-11)

- **Annotation persistence**: Backend reads plain COCO, extended COCO, and LabelMe (auto-detected by presence of `shapes` key). Reads are fully lenient (missing arrays treated as empty). Backend writes only extended COCO. Polygons are the preferred segmentation format — COCO and LabelMe polygon segmentations are preserved as-is (not rasterized); RLE segmentations from external sources are converted to contour polygons via border-tracing on read. All annotations are written as polygon segmentation; RLE is no longer written. Area computed via shoelace formula. Extended sidecar keys: `nemolab_labels`, `nemolab_comments`, `nemolab_authors`, `nemolab_mask_authors`. Writes are debounced 10 s after last modification. Single-file mode writes to `nemolab.json`; per-image mode writes to `<imagename>.json`. Mode switching migrates only the current image lazily; other images are migrated when next accessed. (2026-04-11, updated 2026-04-19)

- **Comment authors**: `nemolab_authors` mirrors `nemolab_comments` — same keys, value = username string of the last editor. Updated atomically with the comment on each edit. Displayed read-only alongside the comment textarea ("Last edited by <user>"). Missing key means no author recorded. (2026-04-16)

- **Mask authors**: `nemolab_mask_authors` maps annotation id string to username of the last user who modified that mask. Backend updates it atomically during `save_annotations` when a mask changes (create, geometry, or label changes), clears entries for removed masks, and frontend shows a read-only `by <user>` byline in the Annotations list row when present. (2026-04-19)

- **Image content hash**: On annotation write, nemo-lab stores `nemolab_hash_sha256` (lowercase hex SHA-256 of image file bytes) and `nemolab_hash_algo: "sha256"` in the image entry. Hash is computed asynchronously post-write. First write: hash is computed and stored. Subsequent writes: stored hash is re-verified asynchronously; mismatch pushes `image_hash_mismatch` WS message to frontend, which shows a visible warning banner. External files without these fields are silently accepted. (2026-04-16)

- **Left sidebar image controls**: Top-to-bottom order is image index input (1-based, Enter to jump, clamped), image name basename (no `"Image:"` prefix), navigation icon row (previous/next/fast-forward), and download icon row (download image/download annotation). Buttons are icon-only (inline SVG) with native titles: `Previous image`, `Next image`, `Jump to first unannotated image`, `Download image file`, `Download annotation file`. Fast-forward jumps to the first image after current whose annotation file is missing or has zero masks; no-op if none. Download endpoints: image `GET /images/{hash}/raw`, annotation `GET /api/annotations/download?hash={hash}`; both disabled when no image is active. (2026-04-16, updated 2026-04-20)

- **Native tooltips**: Interactive controls expose native browser tooltips via `title` attributes (buttons, sliders, checkboxes, selectors, textareas, annotation rows, sidebar toggles, and resize handle), with concise action-oriented text. (2026-04-20)

- **Comment textarea styling**: Comment textareas in the right sidebar have no border (`border: none`). (2026-04-16)

- **Comment panels**: Two independent right-sidebar panels. "Comment/Picture" is always visible — single textarea for the image-level comment (`"image"` key in `nemolab_comments`). "Comment/Annotation" shows only when a mask is selected — single textarea for that mask's comment (annotation id as string key); hidden/cleared on deselection. Both write to the shared annotation store on `input` and follow the normal debounce/propagation cycle. (2026-04-16)

- **Annotation comment persistence**: `nemolab_comments` is a flat string map — key `"image"` for the image-level comment, annotation `id` as string for per-annotation comments. Missing or empty string means no comment. Comments are persisted in the same debounced write cycle as masks/labels and propagated live to other connected users. (2026-04-16)

- **Annotations panel selection indicator**: The Annotations panel highlights the row of the currently selected mask. When no mask is selected, no row is highlighted. Selecting a mask scrolls its row into view in the panel. (2026-04-13)

- **On-demand image list + prefetch tiling**: Backend derives task image lists from `task.images`, computes image hash as SHA-256 of canonical absolute file path, pushes `image_list` over WS, and handles `prefetch`/`image_ready` flow. `/images/{hash}/manifest.json` and `/images/{hash}/tiles/{z}/{x}_{y}.png` are cache-only HTTP reads; tile generation happens via WS prefetch processing. (2026-04-05)
