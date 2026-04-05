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
| `admins`      | []string | `[]`      | Usernames with admin privileges          |

Example `nemo.toml`:
```toml
listen_addr = ":7255"
static_dir  = "dist"
db_path     = "nemo.db"
logs_dir    = "logs"
admins      = ["ma"]
```

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

## Frontend

### Frontend Build Tooling

- Frontend assets are built with direct CLI tools invoked by VS Code tasks, not `npm` scripts.
- TypeScript bundling uses `esbuild` (`compile js` task) from `frontend/src/main.ts` to `dist/js`.
- SCSS compilation uses `sass` watch mode (`watch-scss` task) from `frontend/src/main.scss` to `dist/css/main.css`.
- `.vscode/launch.json` only launches Go backend and Firefox; it relies on pre-launch/resource tasks and does not run a Node/npm-based dev server.

### Layout

- Left collapsible sidebar: previous / next image buttons
- Center image view: single WebGL canvas fills the area
- Right collapsible sidebar: collapsible panels — [Optics](#optics-panel), masks, labels, annotations, comment/annotation, comment/picture

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

- **Green** (`#4caf50`): `fitLevel < manifest.levels - 1` — viewing below max tile resolution; more detail is available by zooming in
- **Brown** (`#795548`): `fitLevel === manifest.levels - 1` — at the finest tile level; zooming further only upscales pixels

The yellow debug `box-shadow` on `.image-view__canvas` is removed.

### Viewport-Culled Tile Loading

Only tiles whose image-space rectangle intersects the current viewport are fetched. Tiles that scroll or zoom out of view while loading are discarded via the existing `loadingGeneration` guard. On pan or zoom, `loadFitLevelTiles` is re-evaluated and any newly visible tiles are requested.

### Tile Placement Logging

- When a tile texture is uploaded and placed, log a `tile_placed` event with: level, tile coordinates (`tx`, `ty`), and canvas position (`x`, `y`, `width`, `height` in CSS pixels)
- Purpose: diagnose tile jump/flicker bugs by correlating placement position with zoom/pan state at that moment

### Annotations

- Drawn in the same WebGL render pass on top of image tiles — no overlay div
- Click on canvas → convert to image coordinates → add annotation point → redraw
- Removing a dot: update annotation list, redraw — no image reload
