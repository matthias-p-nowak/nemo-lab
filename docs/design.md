# Nemo-Lab Design

## Purpose

Image annotation system supporting large images. Backend in Go, frontend in plain TypeScript (no framework unless specified).

## Folder Layout

```
nemo-lab/
├── backend/          # Go source files (unit tests *_test.go next to source)
│   └── cmd/
│       └── server/
│           └── main.go
├── frontend/
│   ├── resources/    # Static assets: index.html, icons, manifest.json
│   └── src/          # TypeScript and SCSS sources
├── tests/            # pywrite-based e2e tests
└── dist/             # Distribution output
    ├── bin/          # Compiled Go binary
    ├── css/          # Compiled CSS from SCSS
    └── js/           # Compiled JS bundles
```

## Backend

### Configuration

- TOML file (default path: `nemo.toml`)
- Fields:

| Field         | Type     | Default   | Description                              |
|---------------|----------|-----------|------------------------------------------|
| `listen_addr` | string   | `:7033`   | Address the HTTP server listens on       |
| `static_dir`  | string   | `dist`    | Path to compiled frontend assets         |
| `db_path`     | string   | `nemo.db` | Path to the SQLite database file         |
| `logs_dir`    | string   | `logs`    | Path for per-session JSONL log files     |
| `admins`               | []string | `[]`                  | Usernames with admin privileges                          |
| `cache_dir`            | string   | `/tmp/nemo-lab/cache` | Root directory for the on-demand tile cache              |
| `cache_limit_mb`       | int      | `512`                 | Maximum cache size in megabytes; oldest tiles evicted    |
| `cache_evict_interval` | string   | `5m`                  | How often the eviction check runs (Go duration string)   |

Example `nemo.toml`:
```toml
listen_addr = ":7033"
static_dir  = "dist"
db_path     = "nemo.db"
logs_dir    = "logs"
admins      = ["ma"]
cache_dir            = "/tmp/nemo-lab/cache"
cache_limit_mb       = 512
cache_evict_interval = "5m"
```

### Image Handling

When a `set_active_task` WS message is received the backend:
1. Looks up `task.images` folder path from the DB by `task_id`.
2. Recursively scans the folder for image files (`.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`), sorted by full path.
3. Computes SHA-256 of each file's canonical path as its cache key (hash).
4. Pushes an `image_list` message to the client:
   ```json
   { "type": "image_list", "images": [{ "filename": "rel/path.png", "hash": "<sha256>" }, ...] }
   ```
5. Stores a session-local `hash → absolute path` map for use by tiling jobs.

The frontend on receiving `image_list`:
- Resets current index to 0, stores the list.
- Immediately sends a `prefetch` message for the current image and the next 8 hashes.
- On navigation advances, sends `prefetch` for the new current image and next 8.

### Tile Cache

- Tiles are generated exclusively via WS `prefetch` messages — **not** on HTTP request.
- Cache key: SHA-256 of the image's canonical file path.
- Cache layout: `cache_dir/<hash>/manifest.json` and `cache_dir/<hash>/tiles/<level>/<x>_<y>.png`.
- **Tile size: 256 px** (matches `images/tile.py`).
- **Zoom levels**: coarsest level (0) fits the image in a single tile; finest level is full resolution. Formula: `ceil(log2(max(width, height) / tile_size)) + 1`.
- **Level convention**: level 0 = coarsest (1 tile), level N-1 = full resolution — same as `tile.py`.
- Tile generation uses scaled dimensions per level `round(width * scale)` / `round(height * scale)` and writes edge tiles cropped to content bounds (no 256px padding on edges).
- Cache eviction: background goroutine runs every `cache_evict_interval`; walks cache, sorts files by last-access time, removes oldest until total size ≤ `cache_limit_mb`.
- HTTP endpoints serve only from cache (no generation): return 404 if not yet tiled.
  - `GET /images/<hash>/manifest.json`
  - `GET /images/<hash>/tiles/{z}/{x}_{y}.png`

### WS Protocol: prefetch and image_ready

**Frontend → backend** `prefetch`:
```json
{ "type": "prefetch", "hashes": ["<hash0>", "<hash1>", ...] }
```
Backend processes in order:
1. Resolves each hash to a file path via the session's hash→path map.
2. Applies double-checked locking: check manifest exists → acquire per-hash write lock → re-check → generate if absent → release.
3. When the **first hash** is ready, pushes `image_ready` to the client:
   ```json
   { "type": "image_ready", "hash": "<hash0>" }
   ```
4. Remaining hashes are tiled in background; no `image_ready` is sent for them.

**Backend → frontend** `image_ready`: frontend loads `/images/<hash>/manifest.json` and displays the image.

### Logging

- One JSONL log file per WebSocket connection, created on WS connect
- Filename: `dd-HH-mm-ss.jsonl` (day, hour, minute, second of connection time)
- Location: `logs/` directory (created if absent)
- Combined log: backend appends connect/disconnect events; frontend sends log entries over WS and backend appends them
- Storage cap: 20 files maximum; oldest file deleted when limit is exceeded
- WS message format for log entries: `{"type":"log","entry":{...}}` - backend only appends messages of this type; other types are reserved
- Each log line is a JSON object with at minimum a `type` field and a `ts` (RFC3339) field

### Database

- SQLite3
- Schema has a version field (single-row `schema_version` table)
- Automatically migrates from earlier versions

#### Schema: authentication

```sql
CREATE TABLE schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    NOT NULL UNIQUE,
    password TEXT    NOT NULL,  -- bcrypt hash
    is_admin INTEGER NOT NULL DEFAULT 0
);
```

- Sessions are kept in-memory only (`token → user_id` map); a server restart invalidates all sessions.
- `users.is_admin` is synced from the TOML admin list at startup.

### Authentication

- Auth middleware wraps all routes (static files, API, WebSocket)
- Flow:
  1. If a valid session cookie (`nemo_session`) is present → pass through
  2. If Basic Auth credentials are present:
     - Auto-creates user if unknown (stores bcrypt hash)
     - Verifies password; on failure → 401
     - On success: generates session token, stores in in-memory map, sets cookie `nemo_session=<token>; HttpOnly; SameSite=Strict; Path=/`
  3. Otherwise → 401 with `WWW-Authenticate: Basic realm="Nemo-Lab"` (triggers browser native login dialog)
- No logout endpoint; sessions expire on server restart

### WebSocket

- `GET /ws` — upgrades to WebSocket
- Requires valid session cookie; returns 401 otherwise
- One connection per browser tab; server tracks open connections keyed by session token
- Serves as bidirectional communication channel and tab identifier

### Tasks Persistence API

- Tasks are persisted in SQLite and exposed through authenticated REST endpoints.
- Data model:
  - `tasks`: scalar fields (`id`, `ord`, `description`, `status`, `images`, `annotations`, `checkmark`, `comment`)
  - `task_tags`: ordered tags per task
  - `task_labels`: ordered hierarchical labels per task (`parent_id` for nesting)
- Endpoints:
  - `GET /api/me` → returns authenticated user info and admin flag
  - `GET /api/tasks` → list all tasks ordered by `ord`, including tags and nested labels
  - `GET /api/dirs?path=...` → list immediate child directory names for a filesystem path
  - `PUT /api/tasks/{id}` → upsert one task
  - `DELETE /api/tasks/{id}` → delete one task
  - `PUT /api/tasks/{id}/tags` → replace complete tag list
  - `PUT /api/tasks/{id}/labels` → replace complete label tree
- Authorization:
  - All endpoints require authenticated users.
  - `DELETE /api/tasks/{id}` and `PUT /api/tasks/{id}/labels` are admin-only.
  - For non-admin users, `PUT /api/tasks/{id}` may only change `status` and `comment`; other fields remain unchanged.
  - `PUT /api/tasks/{id}/tags` is allowed for non-admin users.

## Frontend

### Frontend Build Tooling

- Frontend assets are built with direct CLI tools invoked by VS Code tasks, not `npm` scripts.
- TypeScript bundling uses `esbuild` (`compile js` task) from `frontend/src/main.ts` to `dist/js`.
- SCSS compilation uses `sass` watch mode (`watch-scss` task) from `frontend/src/main.scss` to `dist/css/main.css`.
- `.vscode/launch.json` only launches Go backend and Firefox; it relies on pre-launch/resource tasks and does not run a Node/npm-based dev server.

### Layout

- Left collapsible sidebar: previous / next image buttons, image index field, fast-forward button
- Center image view: single WebGL canvas fills the area
- Right collapsible sidebar: collapsible panels — [Optics](#optics-panel), masks, labels, annotations, comment/annotation, comment/picture. Width is user-resizable (drag left edge); see [Right Sidebar](#right-sidebar).

### Menu Bar

A fixed overlay across the top of the screen, toggled by a hamburger icon pinned to the top-left corner. The bar sits above page content (does not shift layout).

Items (left to right):
- **Tasks** — opens the Tasks dialog
- **Views** — dropdown with:
  - Left sidebar (checkmark = visible)
  - Right sidebar (checkmark = visible)
  - ── separator ──
  - Light theme / Dark theme (checkmark = active)
- **Help** — right-aligned; opens the Help dialog

### Help Dialog

Modal dialog opened from the Help menu item. Contains four tabs: **Shortcuts**, **Annotations & Masks**, **Navigation**, **About**. Only one tab is visible at a time; clicking a tab header switches content without closing the dialog. Closed by an ✕ button or clicking the backdrop.

#### Tab: Shortcuts

A table listing all keyboard shortcuts grouped by scope. Columns: Scope | Key | Action. Content is derived from the canonical shortcut table in this document. A short note at the top: *"Shortcuts are active only when the relevant UI area has focus."*

#### Tab: Annotations & Masks

Explanatory text covering:
- **Mask types**: point (left-click), bounding box (click-drag), freehand (click-drag, self-intersecting stroke closes a loop, simple stroke edits the nearest existing mask).
- **Placement**: left-click (point mode); click-drag (bbox / freehand mode). Placement is suppressed while a mask is selected.
- **Selection**: double-click a mask to select it; Escape to deselect; Arrow Up/Down to cycle.
- **Removal**: Shift+left-click removes the nearest mask; Delete removes the selected mask.
- **Labels**: one label is always active (shown highlighted in the Labels panel). Newly placed masks inherit the active label. Right-click near a mask to reassign its label.

#### Tab: Navigation

Explanatory text covering:
- **Prev / Next buttons** in the left sidebar step through the image list one at a time.
- **Index field**: type a number and press Enter to jump directly to that image.
- **Fast-forward button**: jumps to the first image (after the current one) whose annotation file does not exist or contains zero masks.

#### Tab: About

Static content:
- App name: **Nemo-Lab**
- Brief one-line description: *"Image annotation tool for large images."*
- Version string: read from a `/api/version` endpoint (returns a plain JSON string); display as `v<version>`. If the endpoint is unavailable, omit the version line.

### Tasks Dialog

Modal dialog opened from the menu Tasks item. Contains a scrollable list of task cards. Header shows the title "Tasks" and an admin/user badge.

- On open, the frontend fetches current user role via `GET /api/me` and task data via `GET /api/tasks`.
- Admin/non-admin UI mode is derived from server response (`is_admin`), not local toggles.
- Task cards are rendered ordered by backend `ord`.
- Only one task card is expanded at a time (accordion).
- **Admin mode** additionally shows:
  - Editable description, images, and annotations fields (readonly for non-admin)
  - Browse buttons on images and annotations fields
  - Enabled checkmark (disabled for non-admin)
  - Delete button at the bottom of each expanded card
  - "+ new task" button at the end of the list

### Task Card

Each task card is collapsible.

**Collapsed view** shows: status color bullet · first line of description · all tags as inline pins.

**Expanded view** fields:

| Field       | Type / behaviour |
|-------------|-----------------|
| description | Multi-line text; admin-editable |
| status      | Dropdown — new (yellow), doing (blue), done (green), error (red); color bullet updates on change |
| tags        | Inline pins with ✕ delete; text input on right — Enter adds a tag; collapsed summary updates on change |
| images      | Path to a server-side folder; browse button (admin only) |
| annotations | Path to a folder or file; browse button (admin only) |
| checkmark   | Checkbox — "single annotation file 'nemolab.json'"; admin-editable |
| comment     | Multi-line text; editable by all |

**Edit feedback**: typing in any text field adds an orange box-shadow; on blur or Enter it switches to green and fades after 1 s.

**Directory browse behavior**:
- Clicking a browse button opens a modal directory browser overlay.
- The browser lists immediate subdirectories of the current path via `GET /api/dirs`.
- Selecting a directory writes the chosen path back to the input and triggers the same blur/save flow as manual edits.

**Persistence behavior**:
- Scalar task changes persist via `PUT /api/tasks/{id}`.
- Tag changes persist via `PUT /api/tasks/{id}/tags`.
- Label-tree changes persist via `PUT /api/tasks/{id}/labels`.
- Task creation persists via `PUT /api/tasks/{id}` with a generated id and appended `ord`.
- Task deletion persists via `DELETE /api/tasks/{id}`.
- Admin task reorder uses up/down controls in the summary row and persists updated `ord` values via task `PUT` calls.
- Tasks dialog shows loading and saving indicators, and clears prior error banners on successful subsequent operations.

### Tasks Integration Checklist

Remaining implementation checklist for frontend/backend task integration:

1. **Verification**
   - Verify end-to-end admin and non-admin flows:
     - load tasks
     - edit allowed fields
     - enforce forbidden actions
     - persist tags and labels
     - delete/create tasks

### Optics Panel

Collapsible panel in the right sidebar. Contains three sliders:

| Slider               | Range       | Default |
|----------------------|-------------|---------|
| Gamma correction     | 1.0 – 2.2   | 1.0     |
| Brightness (multiply)| 0.5 – 2.5   | 1.0     |
| Brightness (additive)| -100 – 100  | 0.0     |

- Adjustments are applied immediately as sliders move, in order: gamma → multiply → add. Gamma is applied as `pow(rgb, 1/gamma)` (linear-to-sRGB correction: higher gamma = brighter image).
- Clicking the panel title resets all values (image sliders, transform toggles, and mask sliders) to their defaults.
- Labels, sliders, and numeric values are aligned in a three-column grid (label | slider | value).

#### Mask rendering controls

Three additional sliders in the Optics panel, below the transform toggles:

| Slider | Range | Default |
|---|---|---|
| Stroke opacity | 0.0 – 1.0 | 1.0 |
| Fill opacity | 0.0 – 1.0 | 0.4 |
| Stroke width | 1 – 20 px | 3 px |

- Applied immediately to mask rendering as sliders move.
- Persisted in `user_settings` (keys: `mask_stroke_opacity`, `mask_fill_opacity`, `mask_stroke_width`).
- Reset to defaults when the Optics panel title is clicked.

#### Transform toggles

Three checkmark controls below the sliders, laid out in the same column grid (checkmark | label):

| Control           | Label             |
|-------------------|-------------------|
| R                 | Rotate 90 CW      |
| H                 | Horizontal flip   |
| V                 | Vertical flip     |

- Each control is an independent toggle.
- Transforms are applied in fixed order: R first, then H, then V. The 3-bit state `(R, H, V)` fully describes the active transform (e.g. `100` = rotate only, `010` = H-flip only, `011` = H+V = rotate 180).
- `PageUp`/`PageDown` cycles this exact sequence from a document-level handler (except when focus is in `input`/`textarea`/`select`):
  - normal (`000`) → rotate 90 CW (`100`) → rotate 180 (`011`) → rotate 270 (`111`) → horizontal flip (`010`) → horizontal flip + rotate 90 (`110`) → horizontal flip + rotate 180 (`001`) → horizontal flip + rotate 270 (`101`).
- Cycling wraps at both ends.
- Keyboard cycling updates the R/H/V checkmarks to match the active state.
- Clicking the panel title reset also resets R/H/V to off (`000`).

### Image Viewer

- Single WebGL canvas fills the center image-view area
- On initial load: image is fit-to-screen and centered
- Interactive pan/zoom:
  - drag with primary pointer to pan
  - wheel pans vertically; `Shift+wheel` pans horizontally
  - `Ctrl+wheel` zooms around the cursor position
- Pan/zoom is clamped so image bounds stay near the viewport (20px overscroll allowance)
- Tile metadata loaded from `manifest.json` (`width`, `height`, `tile_size`, `levels`, `tiles` URL pattern)
- Tile level selection tracks current zoom: pick the first level whose resolution exceeds the zoomed viewport target (`zoom * imageSize * devicePixelRatio`)

### Coordinate Systems

- **Image space**: normalized 0..1 in both axes, origin top-left
- **Canvas space**: CSS pixels, resized to fill the image-view area
- Click position is mapped from canvas space → image space using the current fit transform

### Load Sequence

1. Fetch `manifest.json`
2. Fetch level-0 tile (`tiles/0/0_0.png`) — small, arrives fast
3. Upload level-0 tile as a WebGL texture; render fit-to-screen centered in canvas
4. In parallel, fetch all tiles for the appropriate fit-to-screen level
6. As each tile arrives, upload as WebGL texture and blit at correct position — replacing the corresponding region of the level-0 texture
7. On resize: clamp pan/zoom for new viewport, recompute fit level, re-fetch tiles for new level if it changed, redraw

### Canvas Zoom Level Indicator

The canvas border color reflects the current zoom state relative to the image's native resolution:

- **Yellow** (`#fbc02d`): image not yet ready in the viewer (waiting for `image_ready`/manifest load)
- **Green** (`#4caf50`): `fitLevel < manifest.levels - 1` — viewing below max tile resolution; more detail is available by zooming in
- **Brown** (`#795548`): `fitLevel === manifest.levels - 1` — at the finest tile level; zooming further only upscales pixels

The yellow debug `box-shadow` on `.image-view__canvas` is removed.

### Viewport-Culled Tile Loading

Only tiles whose image-space rectangle intersects the current viewport are fetched. Tiles that scroll or zoom out of view while loading are discarded via the existing `loadingGeneration` guard. On pan or zoom, `loadFitLevelTiles` is re-evaluated and any newly visible tiles are requested.

### Tile Placement Logging

- When a tile texture is uploaded and placed, log a `tile_placed` event with: level, tile coordinates (`tx`, `ty`), and canvas position (`x`, `y`, `width`, `height` in CSS pixels)
- Purpose: diagnose tile jump/flicker bugs by correlating placement position with zoom/pan state at that moment

### User Settings

Certain UI preferences are persisted per user in the backend and restored on next login.

**Persisted settings:**

| Key                   | Values / type        | Description                        |
|-----------------------|----------------------|------------------------------------|
| `theme`               | `light` \| `dark`    | Active color theme                 |
| `sidebar_left`        | `visible` \| `hidden`| Left sidebar collapsed/expanded    |
| `sidebar_right`       | `visible` \| `hidden`| Right sidebar collapsed/expanded   |
| `optics_gamma`        | float string         | Gamma correction slider value      |
| `optics_brightness_mul` | float string       | Brightness multiply slider value   |
| `optics_brightness_add` | float string       | Brightness additive slider value   |
| `optics_rotate90cw`   | `0` \| `1`           | R transform toggle state           |
| `optics_flip_h`       | `0` \| `1`           | H transform toggle state           |
| `optics_flip_v`       | `0` \| `1`           | V transform toggle state           |
| `sidebar_right_width` | integer string (px)  | Right sidebar width in CSS pixels  |

**Storage:** `user_settings` SQLite table — one row per (user_id, key). Values stored as strings.

**API:**
- `GET /api/settings` — returns all settings for the authenticated user as a flat JSON object `{ key: value, ... }`.
- `PUT /api/settings` — accepts a flat JSON object; upserts each key for the authenticated user.

**Behavior:**
- On login/page load, frontend fetches `GET /api/settings` and applies each setting before first render.
- Each setting is written via `PUT /api/settings` immediately when it changes in the UI.
- `theme` is no longer sourced from `nemo.toml`; the server-side default is `light` when no setting exists.

### Focus Scope Tracking

When a `[data-shortcut-scope]` element itself receives focus (not a child inside it), two things happen:

- **Visual flash**: a CSS class `scope-focus-flash` is added to the element and removed after 500 ms. The class applies `box-shadow: 0 0 0 3px lightblue` with a `transition: box-shadow 0.5s ease-out` so the shadow fades out smoothly.
- **Backend log**: `logEvent("focus_scope", { scope: scopeName })` is sent over WS, where `scopeName` is the element's `data-shortcut-scope` value.

Implementation:
- One `document.addEventListener("focusin", handleFocusIn)` registered at startup.
- `handleFocusIn` checks `event.target.closest('[data-shortcut-scope]') === event.target`; if not, ignore.
- No persistent state change in `appState` — purely observational.

### Shortcut Scope System

Keyboard shortcuts are scoped to UI regions. A `keydown` event only triggers a shortcut if `event.target.closest('[data-shortcut-scope]')` resolves to a scope that owns that shortcut.

- **Innermost scope wins**: `closest` returns the nearest ancestor with `data-shortcut-scope`; only that scope's shortcuts are evaluated.
- **No bubbling**: a shortcut never fires in an outer scope when an inner scope is matched.
- **No fallback**: if no `[data-shortcut-scope]` ancestor exists, all shortcuts are suppressed.

#### Scopes

| Scope | Element | Notes |
|---|---|---|
| `canvas` | `.image-view` wrapper div | `tabindex="0"`; receives focus on click; canvas element stays a pure rendering surface |
| `navigation` | Image navigation section in the left sidebar | |
| `optics` | Optics panel body | |
| `labels` | Labels panel body | |
| `annotations` | Annotations panel body | |
| `commentImage` | Comment/picture panel body | |
| `commentAnnotation` | Comment/annotation panel body | |
| `taskDialog` | Tasks modal dialog root | |
| `taskLabelTree` | Label tree container within a task card (editable, admin only) | Innermost inside `taskDialog` |

#### Shortcut table

| Scope | Key | Action |
|---|---|---|
| `canvas` | `PageUp` | Cycle optics transform forward |
| `canvas` | `PageDown` | Cycle optics transform backward |
| `canvas` | `Escape` | Deselect selected mask; close context menu |
| `canvas` | `Delete` | Remove selected mask |
| `canvas` | `ArrowUp` | Cycle mask selection backward |
| `canvas` | `ArrowDown` | Cycle mask selection forward |
| `canvas` | `p` | Switch mask mode to **point** |
| `canvas` | `r` | Switch mask mode to **bounding box** |
| `canvas` | `f` | Switch mask mode to **freehand** |
| `navigation` | `Enter` | Jump to typed image index |
| `taskDialog` | `Enter` | Add tag / commit field / add label (by target selector) |
| `taskLabelTree` | `ArrowUp` / `ArrowDown` | Reorder label within parent |
| `taskLabelTree` | `ArrowLeft` / `ArrowRight` | Promote / demote label in hierarchy |
| `taskLabelTree` | `Tab` / `Shift+Tab` | Move focus between label rows |

#### Toast Notification on Mode Change

When the mask mode changes (via shortcut or dropdown), a small toast notification appears briefly in the canvas area:

- Content: the new mode name, e.g. `point`, `bounding box`, `freehand`.
- Position: bottom-center of the `.image-view__canvas-wrap`.
- Duration: visible for 2 seconds, then fades out (CSS opacity transition 0.3 s).
- Implementation: a single `<div class="mode-toast">` element appended to `.image-view__canvas-wrap`, shown by adding `.mode-toast--visible` and removed after 2 s via `setTimeout`.
- Only one toast is shown at a time; a new mode change resets the timer.

#### Implementation

- A single `document.addEventListener("keydown", handleKeydown)` replaces all current global keydown handlers.
- `handleKeydown` resolves the scope via `event.target.closest('[data-shortcut-scope]')`; if none → return early.
- Dispatches to a per-scope handler based on `scope.dataset.shortcutScope`.
- The editable-element guard (`INPUT/TEXTAREA/SELECT`) is dropped — scope placement makes it redundant.
- The `.image-view` wrapper gets `tabindex="0"` and `data-shortcut-scope="canvas"`. Clicking anywhere in the image view calls `.focus()` on the wrapper.
- Canvas wheel events remain bound directly on the canvas element (`{ passive: false }`); unaffected by this system.

### DOM Update Strategy

Targeted `updateXxxUI()` functions replace `render()` for all state changes that do not require a full UI rebuild. Each function rewrites only the affected panel/element's `innerHTML`.

Event handlers are bound once via **event delegation** on `appRoot` at startup. Each handler uses `e.target.closest('[data-action="..."]')` to identify the source. Handlers survive `innerHTML` replacements inside panels — no rebinding after panel updates.

Migration:
1. Convert existing `bindXxxHandlers()` calls to delegation on `appRoot` (bind once at startup).
2. Remove rebind calls from all `updateXxxUI()` functions.
3. Replace remaining `render()` call sites with targeted `updateXxxUI()` functions.

### Focus Preservation in render()

The `render()` function rebuilds the HTML tree, which causes the browser to lose the currently focused element. To prevent this:

- Before rebuilding the DOM, record `document.activeElement` and enough identity to re-focus it after render (e.g. a CSS selector or `id`).
- After the DOM is rebuilt, locate the matching element and call `.focus()` on it.
- If no element was focused, or the focused element no longer exists after render, do nothing.

### GUI Cleanup

- Both sidebar headers (`sidebar--left` and `sidebar--right`) have no label text — the header retains only the toggle button.
- `div.image-view__toolbar` is removed entirely from the layout.
- The "Masks" panel in the right sidebar is removed.
- Panels have no headers — `renderPanel` emits only a `panel__body`, no title bar.
- The optics panel has a top margin (`36px`) to clear the right sidebar collapse/expand button, and a small "reset" button aligned to the bottom-right of the panel body.

### Menu Bar

The menu bar is restructured so that sidebar toggle buttons are always visible and the menu content is invisible and non-interactive when closed:

- The left-sidebar toggle button and right-sidebar toggle button are **always visible**, fixed-positioned in the top corners (left and right respectively), independent of menu open state.
- The hamburger button is **always visible**, fixed-positioned between the two sidebar toggles.
- Only the menu items (Tasks, Views, Help) and the bar background/border toggle:
  - **Closed**: invisible and `pointer-events: none` — mouse events pass through to the canvas below.
  - **Open**: visible, fully interactive, with background and border.
- No overlap between any of these controls.

### Right Sidebar

- Width is user-resizable via a drag handle on the left edge of the sidebar.
- Default width: `320px`. Minimum width: `200px`. No maximum enforced.
- Width is persisted in `user_settings` as `sidebar_right_width` (integer string, CSS pixels). Loaded on page load; written on drag end.
- The layout uses a CSS variable `--sidebar-right-width` (default `320px`) in `grid-template-columns` instead of a hardcoded value.
- A `<div class="sidebar__resize-handle">` as the first child of `.sidebar--right` acts as the drag target (`cursor: ew-resize`, `width: 4px`, absolutely positioned on the left edge).
- On `pointerdown` on the handle, `pointermove` updates `--sidebar-right-width` = `document.body.clientWidth − event.clientX`, clamped to min `200px`; `pointerup` persists the value.
- `.sidebar__content` has `flex: 1` and `overflow-y: auto` so panels scroll vertically and are never clipped.
- Each `.panel` expands to its natural content height — no fixed or max height on `.panel` or `.panel__body`.

### Left Sidebar

- Structure mirrors the right sidebar: a scrollable `.sidebar__content` area with a top margin sufficient to clear the two fixed buttons (left-sidebar toggle and hamburger).
- The hamburger button is positioned adjacent to (next to) the left-sidebar show/hide toggle button, both fixed at the top-left corner.
- `.sidebar__content` on the left sidebar has `overflow-y: auto` so its panels scroll vertically and are never clipped.

#### Image index field

- A numeric input showing the 1-based index of the current image in the image list (e.g. `3` when viewing the third image).
- Editable: user can type a number and press Enter to jump directly to that image (clamped to valid range).
- Updated whenever the active image changes.

#### Fast-forward button

- Jumps to the first image (by list order, starting after the current image) whose annotation file on disk does **not** exist or contains zero masks.
- "Annotation file on disk" follows the current mode: single-file (`nemolab.json`) or per-image sidecar.
- If no such image exists (all remaining images are annotated), the button does nothing (no navigation).
- The check is performed against the file system at the moment the button is clicked (not cached state).

### Mask Mode Selector

A dropdown panel in the right sidebar, placed between the Labels panel and the Masks panel. It shows the currently active mask mode and allows the user to switch between modes.

**Modes:**

| Mode | Description |
|------|-------------|
| `point` | Places a single-point mask on left-click |
| `bounding box` | Places a rectangular mask by click-drag |
| `freehand` | Places a freehand polygon mask by click-drag |

- Default mode on task load: `point`.
- The selected mode controls placement behavior for left-click interactions on the canvas.
- Selecting `bounding box` (not yet implemented) displays an inline error message in the panel: "Mode not yet supported."
- Freehand mode is fully implemented; see [Freehand mask drawing](#freehand-mask-drawing).

### Masks

A mask is a geometric figure placed on the image canvas.

- Masks are numbered sequentially (1, 2, 3, …) per image.
- The image view cursor is a **crosshair** at all times.
- Placement behavior depends on the active [mask mode](#mask-mode-selector).
- **Left-click** (point mode): places a point mask at the cursor position. Placement is disabled while a mask is selected, and also suppressed when the click lands on an existing mask (to avoid creating a mask on the first click of a double-click).
- **Left-click drag** (bounding box mode): defines the rectangle by drag; mask is placed on release.
- **Left-click drag** (freehand mode): records pointer path as a freehand polygon; mask is placed on release.
- **Shift+left-click**: removes the closest existing mask (if any within a reasonable hit radius).
- Masks are rendered in the WebGL pass on top of image tiles — no overlay div.
- **Bounding box masks** (loaded from COCO `bbox` annotations) are rendered as a filled rectangle with an outline, using the same fill/outline color and opacity rules as point masks. The rectangle is defined in image-normalized coordinates.

#### Bounding box placement (bounding box mode, no mask selected)

- On `pointerdown`: record the start position.
- If pointer travels ≥ 10 CSS px before `pointerup`: draw and continuously update a live rectangle from start to current position.
- On `pointerup`: finalize the bbox at the release position (opposite corner from start).
- If travel < 10 CSS px: ignore (no mask created).

#### Bounding box editing (bounding box mode, one bbox mask selected)

- Only side movement is supported (no corner resize, no whole-box drag).
- On `pointerdown`: determine which side the pointer is nearest to (if within a reasonable hit distance).
- Dragging from either direction (inside or outside the box) moves that side.
- On `pointerup`: side is placed at the release position.

#### Freehand mask drawing

Geometry library: **Shapely** (`LineString`, `Polygon`, `unary_union`, `polygonize`, `split`, `simplify`).
Reference implementation: `~/projects/ai-code/annotrix/wt/dev0/tmp/freehand_trial.py`

**Stroke capture (during drag)**
- On pointer down: begin collecting stroke points.
- On pointer move: append a point only if Euclidean distance from the last sampled point ≥ `min_sample_distance_px` (default 3 px, configurable). Draw a live red preview line.
- Stroke shorter than `min_sample_distance_px` after sampling → no-op.

**On release: classify stroke**

Convert sampled points to a Shapely `LineString`, then branch on `stroke.is_simple`:

*A. Self-intersecting stroke → create new loop*
1. `merged = unary_union(stroke)` — splits the line at self-intersection points.
2. Count resulting segments. If > `max_self_intersection_segments` (default 3) → reject (no-op).
3. `loops = polygonize(merged)` — extract enclosed polygons. If none → no-op.
4. Keep the largest-area loop.
5. Apply `simplify(tolerance, preserve_topology=True)` (default tolerance 0.5 px).
6. Append to mask list.

*B. Simple (non-self-intersecting) stroke → edit existing loop*

Near-endpoint closure rule: if the stroke endpoint is < `closure_distance_px` (default 10 px) from the start, close the stroke and treat it as a new loop via path A.

For editing an existing loop:
1. For each loop compute **overlap score** = `outline.intersection(stroke)`: nonzero length → score = length; point-only intersection → score = point count; zero → skip.
2. Select loop with highest score. Tie-break: larger area; then stable lowest index.
3. **Split/rejoin**: split the loop outline at the stroke and the stroke at the outline (need ≥ 3 parts each, else no-op). Try all combinations of kept outline parts + stroke part; `polygonize` each; keep the largest valid resulting polygon. Apply simplification.
4. No valid candidate → no-op.

**Rendering**
- Live stroke preview: red outline.
- Finalized freehand masks: rendered with the standard fill/outline color and opacity rules (same as point and bbox masks).

#### Mask selection

- **Double-click** on a mask selects it. Only one mask can be selected at a time.
- **Escape** cancels the current selection (returns to no mask selected).
- **Arrow up / Arrow down** cycle through masks in index order; the cycle includes a "none selected" state.
- **Delete** key (when a mask is selected) removes the selected mask.
- **Clicking an annotation row** in the Annotations panel selects that mask.

#### Mask and label colors

- **Fill color** is per-mask: derived from the mask's sequential index using the mask fill palette (S=0.50, V=0.70 — muted).
- **Outline color** is per-label: derived from the label's depth-first index in the task label tree using the label outline palette (S=0.75, V=0.90 — vivid). Unlabeled masks get a neutral outline (`#888888`).
- Label colors are stable across all images in the task (depth-first index in the label tree is task-level, not image-level).
- The two palettes use different HSV parameters so fill and outline colors never collide.
- **Default opacity**: fill 40% (alpha 0.4), outline 100% (alpha 1.0). Both are user-adjustable (see [Optics Panel](#optics-panel)).
- When **no mask is selected**: all masks are drawn with fill and outline.
- When **a mask is selected**: the selected mask is drawn with fill and outline; non-selected masks are drawn with outline only (no fill).

#### Color algorithm

Both palettes use bit-reversed hue; only the HSV parameters differ:

| Palette | Used for | S | V |
|---|---|---|---|
| Label/outline | Outline color, label tree display | 0.75 | 0.90 |
| Mask/fill | Fill color | 0.50 | 0.70 |

1. **Bit-reverse** index `n` within 8 bits → hue `h = reversed / 256 ∈ [0, 1)`.
2. **Convert HSV → RGB** with the palette's S and V values.

```ts
function labelColor(n: number): string {        // outline / label display
  return indexToHsvColor(n, 0.75, 0.90);
}
function maskFillColor(n: number): string {     // fill
  return indexToHsvColor(n, 0.50, 0.70);
}
function indexToHsvColor(n: number, s: number, v: number): string {
  const BITS = 8;
  let r = 0;
  for (let i = 0; i < BITS; i++) r = (r << 1) | ((n >> i) & 1);
  return hsvToRgbCss(r / (1 << BITS), s, v);
}
```

### Labels

- A hierarchical system of categories, each identified by name.
- The label tree is per-task (already modeled in `task_labels`).

### Default Label

The label panel in the right sidebar (read-only view) doubles as a label selector:

- Exactly one label is selected at all times when the active task has labels. `appState.activeLabelSelectedId` is the source of truth.
- On task activation: auto-select the first leaf label in the tree (depth-first). If the task has no labels, `activeLabelSelectedId` is `null`.
- Clicking any `label-tree__row` in the sidebar sets that label as selected (`activeLabelSelectedId`) and re-renders the label panel to reflect the new selection.
- The selected label is the default label auto-assigned to newly placed masks (replaces the `recentLabels[0]` fallback in `addMask`).
- When a label is assigned to a mask via right-click context menu, `activeLabelSelectedId` is updated to that label and the label panel re-renders to reflect the new selection.

### Annotations

An annotation is the assignment of a label to a mask.

#### Annotations panel selection indicator

- The Annotations panel in the right sidebar lists all masks for the current image.
- Each row may show a small read-only creator/editor byline (`by <username>`) when `nemolab_mask_authors["<annotation_id>"]` exists.
- The row corresponding to the currently selected mask is visually highlighted (e.g. distinct background or border).
- When no mask is selected, no row is highlighted.
- Selecting a mask (via double-click or Arrow up/down) scrolls its row into view in the panel.

- **Right-click** within 10 CSS px of a mask opens a context menu:
  - Lists recently used labels, most recent on top.
  - Clicking a list item assigns that label to the mask.
- The **last assigned label** is the default for the next placed mask (auto-assigned on placement).

### Comment Panels

Two independent collapsible panels in the right sidebar:

#### Comment/Picture panel

- Always visible (not gated on mask selection).
- Contains a single multi-line `<textarea>` for the image-level comment (`"image"` key in `nemolab_comments`).
- Loaded from the annotation store when the active image changes; cleared when no image is active.
- Changes are written to the shared annotation store immediately on `input` and trigger the normal debounced file write and live propagation.

#### Comment/Annotation panel

- Visible only when a mask is selected; shows a placeholder or is collapsed when no mask is selected.
- Contains a single multi-line `<textarea>` for the selected mask's comment (key = annotation `id` as string in `nemolab_comments`).
- Updated when mask selection changes: textarea is repopulated from the store for the newly selected mask.
- Changes are written to the shared annotation store immediately on `input`, same debounce/propagation as above.
- When the mask is deselected (Escape or selection cleared), the textarea is cleared/hidden.

#### Comment textarea styling

- Comment textareas have `border: none` — no visible border.

### Annotation Persistence

#### File format

- The backend reads three formats: plain COCO, extended COCO (written by nemo-lab), and LabelMe.
- Format is auto-detected: presence of a top-level `shapes` key → LabelMe; otherwise → COCO / extended COCO.
- Reading is fully lenient: missing top-level arrays (`images`, `annotations`, `categories`) are treated as empty.
- The backend **writes only extended COCO**.
- **Polygons are the preferred segmentation format.** Polygon segmentations are preserved through the read/write cycle — they are never rasterized to RLE.
  - COCO polygon `segmentation` arrays (`[[x0,y0,x1,y1,...]]`) are kept as-is on read.
  - LabelMe `shapes` with `shape_type: polygon` are converted to COCO polygon format on read (not rasterized).
  - RLE segmentations from external sources are converted to contour polygons on read via border-tracing, so they become visible and editable in the frontend.
- All annotations are written with polygon `segmentation`. RLE is no longer written.
- Area is computed via the shoelace formula on the polygon points.

#### Image content hash

Each image entry in the `images` array written by nemo-lab includes two extra fields:

| Field | Content |
|-------|---------|
| `nemolab_hash_sha256` | Lowercase hex SHA-256 digest of the image file's raw bytes |
| `nemolab_hash_algo` | Always `"sha256"` |

- The hash is computed **asynchronously after the annotation file is written** (does not block the save path).
- On first write (no hash stored yet): the hash is computed, then the annotation file is updated with the hash value.
- On subsequent writes: the previously stored hash is preserved in the file as-is; a background goroutine re-computes the hash and compares it to the stored value.
  - If they match: no action.
  - If they differ: a warning WS message is pushed to the frontend (`type: "image_hash_mismatch"`, `hash`: image hash, `file`: image path).
- The frontend displays a visible warning banner when it receives `image_hash_mismatch`, identifying the affected image.
- External annotation files (not written by nemo-lab) will not have these fields; missing fields are silently ignored on read.

#### Extended COCO sidecar fields (top-level keys)

| Key | Content |
|-----|---------|
| `nemolab_labels` | Full hierarchical label tree for the task |
| `nemolab_comments` | Per-annotation and per-image comments (flat string map) |
| `nemolab_authors` | Last editor of each comment (flat string map, mirrors `nemolab_comments`) |
| `nemolab_mask_authors` | Last editor of each mask (flat string map keyed by annotation id string) |

#### Comment schema

`nemolab_comments` is a flat JSON object mapping string keys to single comment strings:

- Key `"image"` → comment for the image itself.
- Key `"<annotation_id>"` (annotation `id` as string) → comment for that annotation.

Example:
```json
"nemolab_comments": {
  "image": "Blurry in top-left corner.",
  "42": "Uncertain boundary — needs review."
}
```

- Missing key means no comment. Empty string is treated the same as missing.
- Comments are persisted as part of the normal debounced annotation write cycle (same timing as masks and labels).
- Comment changes by any user trigger live propagation to other connections viewing the same file, identical to mask changes.

#### Author schema

`nemolab_authors` is a flat JSON object with the same keys as `nemolab_comments`, mapping each key to the username (string) of the user who last edited that comment.

Example:
```json
"nemolab_authors": {
  "image": "alice",
  "42": "bob"
}
```

- When a user edits a comment, the corresponding author entry is updated to that user's username atomically with the comment update.
- Missing key means no author recorded (comment was never edited in nemo-lab, e.g. imported from external file).
- Author is displayed read-only alongside the comment textarea in the sidebar (e.g. `"Last edited by alice"`); it is never user-editable.

#### Mask author schema

`nemolab_mask_authors` is a flat JSON object mapping annotation id strings to usernames.

Example:
```json
"nemolab_mask_authors": {
  "42": "bob"
}
```

- On each `save_annotations`, backend compares incoming masks to the currently stored version for that image id.
- For masks that changed (new mask, geometry change, or label/category change), the corresponding author key is set to the current user's username (last writer wins).
- Author keys for masks removed from the current image are deleted.
- Frontend renders this as read-only `by <username>` text in each row of the Annotations panel when the key exists.

#### Annotation types

| Type | Stored as |
|------|-----------|
| Type | Stored as |
|------|-----------|
| Point | COCO keypoint |
| Bounding box | COCO `bbox` `[x, y, w, h]` |
| Freehand / Polygon | COCO polygon `segmentation` `[[x0,y0,...]]` |
| RLE (external input) | Converted to contour polygon on read; written as polygon |

#### Write timing and file naming

- Writes are debounced: the file is written 10 seconds after the **last** modification (timer resets on each change).
- **Single-file mode** (`checkmark = true`): all annotations written to `nemolab.json` in the task `annotations` folder.
- **Per-image mode** (`checkmark = false`): annotations written to a JSON file with the same name as the image but with `.json` extension.

#### Mode switching

- When the user switches between single-file and per-image mode, only the **current image's** annotations are migrated immediately (old file read, new file written, old file deleted).
- Subsequent images are migrated lazily when first accessed or modified under the new mode.
- Untouched images retain their old files until naturally overwritten.

### Multi-user Collaboration

#### Shared annotation store

- The backend maintains one **server-side in-memory annotation store**, shared across all connections, keyed by annotation file path.
- Individual connections do not hold their own annotation copies — the shared store is the single authoritative source.
- The 10-second debounce write timer is **per file path** (shared); any user's change resets the timer for that path.

#### Live propagation

- When user A modifies annotations for an image (add/remove/label a mask, or changes a comment):
  1. The shared store is updated immediately using per-mask merge (last write wins per mask id).
  2. The full updated `annotations_data` message for that image is pushed to all **other** connections that currently have the same annotation file path active.
- The receiving frontend applies `annotations_data` identically to a normal load response.

#### Conflict resolution

- Masks are independent units — merge is per mask id, last write wins.
- A mask added by one user is never silently removed by another user saving (unless they explicitly remove it).
- A mask removed by one user is propagated to all other active users immediately.

#### Flush on disconnect

- On connection close, any pending dirty annotations for that connection's active file are flushed to disk immediately (don't wait for the debounce timer).

### Annotation Logging (temporary)

Until persistence is implemented, the frontend logs the following events to the backend over WebSocket:

| Event | Payload fields |
|---|---|
| `mask_created` | image hash, mask index, image-normalized `x`, `y` |
| `mask_removed` | image hash, mask index |
| `label_assigned` | image hash, mask index, label name |
| `mouse_click` | button (`left`\|`right`), canvas `x`, `y`, image-normalized `x`, `y` |

> Persistence of masks and annotations to `nemolab.json` or DB is out of scope for this task.

### Annotation Image-Switch Logging

When the active image changes, the frontend logs the following events over WebSocket:

| Event | Payload fields | Description |
|---|---|---|
| `image_activated` | `filename` (full path) | Full filename of the newly active image |
| `annotations_source` | `file` (path), `count` (int), `file_format` (`coco`\|`extended_coco`\|`labelme`), `annotation_types` (summary string) | One entry per source file loaded; emitted for both per-image sidecar and single-file (`nemolab.json`) modes |
| `annotations_destination` | `file` (path) | Path where new/changed annotations will be written |

- `annotation_types` is a human-readable summary, e.g. `"10 point, 3 bbox"`.
- If no source file exists for the current image, no `annotations_source` event is emitted.
- Both per-image mode and single-file mode emit `annotations_source` (source file path differs by mode).

### Annotation Change Logging

The frontend logs every annotation mutation over WebSocket:

| Event | Payload fields |
|---|---|
| `mask_created` | image hash, mask index, image-normalized `x`, `y` |
| `mask_removed` | image hash, mask index |
| `label_assigned` | image hash, mask index, label name |
