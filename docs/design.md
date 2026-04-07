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
| `listen_addr` | string   | `:7255`   | Address the HTTP server listens on       |
| `static_dir`  | string   | `dist`    | Path to compiled frontend assets         |
| `db_path`     | string   | `nemo.db` | Path to the SQLite database file         |
| `logs_dir`    | string   | `logs`    | Path for per-session JSONL log files     |
| `admins`               | []string | `[]`                  | Usernames with admin privileges                          |
| `cache_dir`            | string   | `/tmp/nemo-lab/cache` | Root directory for the on-demand tile cache              |
| `cache_limit_mb`       | int      | `512`                 | Maximum cache size in megabytes; oldest tiles evicted    |
| `cache_evict_interval` | string   | `5m`                  | How often the eviction check runs (Go duration string)   |

Example `nemo.toml`:
```toml
listen_addr = ":7255"
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

- Left collapsible sidebar: previous / next image buttons
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
- **Help** — right-aligned

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
- Clicking the panel title resets all three values to their defaults.
- Labels, sliders, and numeric values are aligned in a three-column grid (label | slider | value).

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
3. Upload level-0 tile as a WebGL texture; render at natural size centered in canvas
4. Over **0.2 s** animate it growing to fit-to-screen
5. In parallel, fetch all tiles for the appropriate fit-to-screen level
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

### GUI Cleanup

- Both sidebar headers (`sidebar--left` and `sidebar--right`) have no label text — the header retains only the toggle button.
- `div.image-view__toolbar` is removed entirely from the layout.
- The "Masks" panel in the right sidebar is removed.
- Panels are no longer collapsible — `panel__header` is a plain `<div>`, no toggle button. The optics panel header retains a click-to-reset behavior on its title span.
- The optics panel has a top margin (`36px`) to clear the right sidebar collapse/expand button.

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

### Masks

A mask is a geometric figure placed on the image canvas. Currently only point masks are supported; rectangle and freehand are future extensions.

- Masks are numbered sequentially (1, 2, 3, …) per image.
- The image view cursor is a **crosshair** at all times.
- **Left-click**: places a point mask at the cursor position.
- **Shift+left-click**: removes the closest existing mask (if any within a reasonable hit radius).
- Masks are rendered in the WebGL pass on top of image tiles — no overlay div.

### Labels

- A hierarchical system of categories, each identified by name.
- The label tree is per-task (already modeled in `task_labels`).

### Annotations

An annotation is the assignment of a label to a mask.

- **Right-click** within 10 CSS px of a mask opens a context menu:
  - Lists recently used labels, most recent on top.
  - Clicking a list item assigns that label to the mask.
- The **last assigned label** is the default for the next placed mask (auto-assigned on placement).

### Annotation Logging (temporary)

Until persistence is implemented, the frontend logs the following events to the backend over WebSocket:

| Event | Payload fields |
|---|---|
| `mask_created` | image hash, mask index, image-normalized `x`, `y` |
| `mask_removed` | image hash, mask index |
| `label_assigned` | image hash, mask index, label name |
| `mouse_click` | button (`left`\|`right`), canvas `x`, `y`, image-normalized `x`, `y` |

> Persistence of masks and annotations to `nemolab.json` or DB is out of scope for this task.
