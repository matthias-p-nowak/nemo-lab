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

- **Mask selection**: Double-click selects a mask; Escape cancels selection; Arrow up/down cycle through masks (cycle includes "none selected"). While a mask is selected, left-click placement is disabled (temporary restriction). (2026-04-11)

- **Mask and label colors**: Two distinct palettes — fill uses mask index with S=0.50 V=0.70 (muted); outline uses label depth-first index with S=0.75 V=0.90 (vivid). Label colors are task-level stable. Default opacity: fill 40%, outline 100%. Unlabeled masks get `#888888` outline. No selection: all masks show fill+outline. With selection: selected mask shows fill+outline, others show outline only. (2026-04-11, updated 2026-04-11)

- **Mask rendering controls in Optics panel**: Four sliders — stroke opacity (0–1, default 1.0), fill opacity (0–1, default 0.4), stroke width (1–5 px, default 3 px), marker size (5–30 px, default 10 px). Outline drawn as ring (annulus); fill drawn as solid inner circle. Applied immediately via `applyOpticsToViewer()`, persisted as `mask_stroke_opacity`, `mask_fill_opacity`, `mask_stroke_width`, `mask_marker_size`. Reset by panel-title click. (2026-04-11)

- **Masks and annotations**: Point masks placed by left-click, removed by shift+left-click (closest within hit radius). Crosshair cursor on image view. Right-click within 10px of a mask opens context menu with recent labels; clicking assigns label to mask. Last assigned label auto-assigned to next mask. Logged to backend over WS (`mask_created`, `mask_removed`, `label_assigned`, `mouse_click`). Persistence deferred. (2026-04-07)

- **Menu bar restructure**: Left and right sidebar toggles are always-visible fixed buttons. The hamburger + menu items form a middle section that is invisible and `pointer-events: none` when closed (mouse events pass through to canvas). Hamburger moves inside the menu bar middle section. (2026-04-07)

- **GUI cleanup**: Remove `<strong>` label text from both sidebar headers; remove `div.image-view__toolbar` entirely; fix hamburger/left-sidebar-toggle collision by moving hamburger to `left: 52px`. (2026-04-07)

- **Right sidebar resizable**: The right sidebar width is user-resizable via a drag handle on its left edge. Default `320px`, min `200px`. Width is persisted in `user_settings` as `sidebar_right_width`. Layout uses CSS variable `--sidebar-right-width`. Sidebar content scrolls vertically; panels expand to natural height. (2026-04-07)

- **User settings persistence**: UI preferences (theme, sidebar visibility, optics sliders and transform toggles) are persisted per user in a `user_settings` SQLite table (one row per user_id + key, value as string). Exposed via `GET /api/settings` and `PUT /api/settings`. Frontend loads settings on page load and writes each setting immediately on change. Theme is no longer sourced from `nemo.toml`; default is `light`. (2026-04-07)

- **Multi-user annotation collaboration**: Backend holds one shared in-memory annotation store keyed by file path. Any user's change is merged per-mask (last write wins per mask id) and broadcast as full `annotations_data` to all other connections viewing the same file. Debounce write timer is per file path (shared). Pending dirty state is flushed on connection close. (2026-04-11)

- **Annotation persistence**: Backend reads plain COCO, extended COCO, and LabelMe (auto-detected by presence of `shapes` key). Reads are fully lenient (missing arrays treated as empty). Backend writes only extended COCO. Polygons are rasterized to COCO-RLE on read and never written as polygons. RLE variant is COCO-RLE (column-major). Extended sidecar keys: `nemolab_labels`, `nemolab_comments`, `nemolab_authors`. Writes are debounced 10 s after last modification. Single-file mode writes to `nemolab.json`; per-image mode writes to `<imagename>.json`. Mode switching migrates only the current image lazily; other images are migrated when next accessed. (2026-04-11)

- **On-demand image list + prefetch tiling**: Backend derives task image lists from `task.images`, computes image hash as SHA-256 of canonical absolute file path, pushes `image_list` over WS, and handles `prefetch`/`image_ready` flow. `/images/{hash}/manifest.json` and `/images/{hash}/tiles/{z}/{x}_{y}.png` are cache-only HTTP reads; tile generation happens via WS prefetch processing. (2026-04-05)
