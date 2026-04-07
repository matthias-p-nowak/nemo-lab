# Nemo-Lab Architecture

## Backend runtime wiring

- `backend/cmd/server/main.go` loads config from `nemo.toml`, opens SQLite, syncs `users.is_admin` from config admins, configures tile cache service, registers routes, wraps all routes with auth middleware, and starts the HTTP server.
- Routes:
  - `/api/me` handled by `backend/cmd/server/main.go` and returns `username` + `is_admin` for the authenticated user.
  - `/api/settings` handled by `backend/cmd/server/main.go` for per-user UI settings load/save.
  - `/api/tasks` handled by task handlers in `backend/cmd/server/main.go` backed by `backend/tasks`.
  - `/ws` handled by `backend/ws`.
  - `/images/` handled by `backend/tiles` for tile-manifest and tile-PNG requests, with static fallback to `images/` for other paths.
  - `/` served by static file server rooted at configured `static_dir`.

## Config

- Implemented in `backend/config/config.go` using TOML (`BurntSushi/toml`).
- Fields: `listen_addr`, `static_dir`, `db_path`, `logs_dir`, `admins`, `cache_dir`, `cache_limit_mb`, `cache_evict_interval`.
- Defaults if missing: `:7255`, `dist`, `nemo.db`, `logs`, `[]`, `/tmp/nemo-lab/cache`, `512`, `5m`.

## Tiles cache

- Implemented in `backend/tiles/tiles.go`.
- `tiles.Configure(cacheDir, cacheLimitMB, cacheEvictInterval)` initializes a package-global service and starts background eviction.
- `tiles.NewHandler()` handles:
  - `GET /images/{hash}/manifest.json`
  - `GET /images/{hash}/tiles/{z}/{x}_{y}.png`
  - fallback static serving from `images/` for other `/images/*` paths.
- `tiles.HashForPath(absPath)` computes SHA-256 hash keys from canonical absolute image paths.
- `tiles.EnsureGeneratedByPath(absPath)` performs double-checked per-hash generation into cache and returns manifest path.
- HTTP tile handler is cache-only and does not trigger generation.
- Cache namespace is per path hash (`SHA-256(absPath)`): `{cache_dir}/{hash}/manifest.json` and `{cache_dir}/{hash}/tiles/{z}/{x}_{y}.png`.
- Tile generation follows the `images/tile.py` level formula and level conventions; edge tiles are persisted at cropped dimensions.
- Concurrent generation for the same hash is serialized by in-flight mutexes.
- Eviction removes oldest files by modification time until total cache size is at or below `cache_limit_mb`.

## Database

- Implemented in `backend/db/db.go` with pure-Go SQLite driver `modernc.org/sqlite`.
- `Open(path)` ensures schema exists and validates schema version.
- Schema includes:
  - `schema_version(version INTEGER NOT NULL)` single-row version tracking.
  - `users(id, username UNIQUE, password, is_admin)`.
  - `user_settings(user_id, key, value)` with composite primary key `(user_id, key)`.
  - `tasks(id, ord, description, status, images, annotations, checkmark, comment)`.
  - `task_tags(task_id, ord, tag)` with `ON DELETE CASCADE` to `tasks`.
  - `task_labels(id, task_id, parent_id, ord, text)` with cascading delete for task and label subtree removal.
- Current schema version is `3`; newer DB versions are rejected.
- On DB open, SQLite pragmas enable WAL mode and foreign-key enforcement.

## Authentication

- Implemented in `backend/auth/auth.go`.
- Middleware behavior:
  1. Accept valid `nemo_session` cookie from in-memory session map.
  2. Else, accept Basic Auth credentials; auto-create unknown users with bcrypt hash and verify known users.
  3. On success, set `nemo_session` cookie with `HttpOnly`, `SameSite=Strict`, `Path=/`.
  4. Otherwise respond `401` with `WWW-Authenticate: Basic realm="Nemo-Lab"`.
- Sessions are in-memory `token -> user_id`; restart invalidates all sessions.

## WebSocket

- Implemented in `backend/ws/ws.go`.
- `/ws` requires a valid `nemo_session` token.
- On success, upgrades to WebSocket and tracks active connections per session token in memory.
- Per connection, backend creates one JSONL session log file via `backend/logger/logger.go` in configured `logs_dir`.
- Session log filenames use `dd-HH-mm-ss.jsonl`; logger enforces max 20 files by deleting oldest lexicographic file before create.
- Backend appends connect/disconnect entries (`type`, `ts`, and `token_prefix` on connect).
- Session state stores `activeTaskID` and a hash-to-path map for scanned task images.
- `set_active_task` handling:
  - looks up `tasks.images` path for task id
  - recursively scans image files
  - canonicalizes absolute paths and computes `tiles.HashForPath`
  - stores session hash→path map
  - pushes `{ "type": "image_list", "images": [{ "filename", "hash" }, ...] }`.
- `prefetch` handling:
  - resolves hashes against the session map
  - runs in a background goroutine so the WS receive loop remains responsive during long tile generation
  - aborts prefetch work early when a newer request supersedes it (per-connection sequence check)
  - processes `hashes[0]` first and emits `{ "type": "image_ready", "hash": ..., "level": ..., "total_levels": ... }` progress events
  - suppresses stale `image_ready` events from older superseded prefetch requests using a per-connection sequence number
  - tiles remaining hashes asynchronously without additional ready events, but only for the latest prefetch sequence.
- During prefetch generation, WS forwards structured tile-generation events from `backend/tiles` into the per-session JSONL logger (`tile_generation_start`, `tile_generation_decoded`, `tile_generation_mipmap_done`, `tile_generation_level_done`, `tile_generation_complete`, `tile_generation_cache_hit`).
- Logging messages continue to be appended from `{ "type": "log", "entry": { ... } }` payloads; `set_active_task` can arrive either top-level or as a logged event entry.

## Tasks API

- Core task persistence logic is in `backend/tasks/tasks.go`.
- `tasks.List` and `tasks.Get` load task scalars and join tags/labels in application code.
- Label trees are stored flat (`task_labels`) and materialized via a tree builder keyed by `parent_id`.
- `tasks.ReplaceTags` and `tasks.ReplaceLabels` run in explicit transactions and replace complete sets.
- Route behavior in `backend/cmd/server/main.go`:
  - `GET /api/me`: returns authenticated username and admin flag from `users.is_admin`.
  - `GET /api/settings`: returns `{ key: value }` for current user from `user_settings`.
  - `PUT /api/settings`: upserts each provided key/value for current user in `user_settings`.
  - `GET /api/tasks`: list all tasks for any authenticated user (returns `[]` when empty, never `null`).
  - `GET /api/dirs?path=...`: returns `{ dirs: [...] }` containing immediate child directory names; returns empty list for non-existent paths or non-directory paths.
  - `PUT /api/tasks/{id}`: upsert task; non-admin path loads existing row and applies only `status` and `comment`.
  - `DELETE /api/tasks/{id}`: admin-only.
  - `PUT /api/tasks/{id}/tags`: authenticated users can replace tags.
  - `PUT /api/tasks/{id}/labels`: admin-only label-tree replacement.
- Task API handlers emit debug logs (`tasks_api ...`) for start/success/error paths including method, URL path, username, and admin flag.

## Frontend tasks dialog

- Tasks dialog behavior is implemented in `frontend/src/main.ts`.
- Opening the dialog triggers `fetch("/api/me")` and `fetch("/api/tasks")`, then normalizes response rows into UI `Task` state (including label-tree mapping and selected-label initialization).
- Admin mode in the dialog is derived from `/api/me` (`is_admin`), not a local toggle.
- Task cards are rendered in backend order (`ord`, then `id`) and the first task is expanded by default after load.
- A monotonic load token guards against stale async responses overwriting more recent dialog state.
- Frontend write operations call backend endpoints directly:
  - scalar field changes and create/update use `PUT /api/tasks/{id}`
  - tag changes use `PUT /api/tasks/{id}/tags`
  - label-tree changes use `PUT /api/tasks/{id}/labels`
  - delete uses `DELETE /api/tasks/{id}`
- Admin task reorder uses up/down controls in each summary row; after local reorder, frontend persists updated order by issuing scalar `PUT /api/tasks/{id}` calls across the reordered list.
- Tasks dialog exposes operation state in-UI:
  - loading indicator while `GET /api/me` + `GET /api/tasks` are in flight
  - saving indicator while write calls are in flight
  - error banner for load/save failures, auto-cleared after a successful later operation
- Task load/save failures are also forwarded to backend logs from the frontend over WebSocket via `logEvent("task_error", ...)`.
- Admin-only browse buttons for `images` and `annotations` open a dedicated directory-browser modal.
- Directory-browser modal behavior:
  - queries `GET /api/dirs` for current path
  - supports parent (`..`) navigation
  - writes selected path into the corresponding input and reuses existing save-on-blur behavior

## Frontend user settings

- Implemented in `frontend/src/main.ts`.
- On startup, frontend fetches `GET /api/settings`, applies theme/sidebar/optics settings, then performs first `render()`.
- UI changes immediately persist via `PUT /api/settings`:
  - theme menu selection (`theme`)
  - sidebar visibility toggles (`sidebar_left`, `sidebar_right`)
  - right sidebar drag width (`sidebar_right_width`)
  - optics sliders and transform toggles (`optics_*` keys)

## Frontend image viewer

- Implemented in `frontend/src/main.ts` (`WebGLTileViewer`).
- Task image source is WS-driven: frontend receives `image_list`, stores `{filename, hash}` entries, and requests tiling via `prefetch`.
- Previous/next navigation updates the current index and sends a new `prefetch` window; image display waits for backend `image_ready`.
- On `image_ready`, frontend loads viewer manifests/tiles using hash-based URLs (`/images/{hash}/manifest.json` + manifest tile template).
- Viewer state now tracks `zoom`, `offsetX`, and `offsetY` for interactive navigation.
- Initial image load sets pan/zoom to centered fit using rotation-aware displayed dimensions (swaps width/height when 90° rotate is active) and renders immediately.
- Wheel and pointer behavior:
  - `Ctrl+wheel` zooms around cursor.
  - Wheel pans vertically; `Shift+wheel` pans horizontally.
  - Primary-pointer drag pans image.
- `Ctrl+wheel` zoom applies cursor-centered offset scaling using the actually applied (clamped) zoom ratio, preventing offset drift when zoom is already at min/max clamp.
- `clampPanZoom()` constrains zoom and offsets with a 20px overscroll pad and max zoom `2`, using ordered min/max bounds so pan remains available even when the zoomed image is larger than the canvas.
- Tile level selection (`pickFitLevel`) is based on current zoomed image target (`zoom * manifest dimension * dpr`), and `maybeChangeFitLevel()` reloads tiles when level changes.
- Fit-level tile streaming uses a monotonic load-batch generation token so stale async tile callbacks are ignored, including revisits to the same level after intermediate zoom changes.
- Fit-level tile requests are viewport-culled: only tiles whose level-space rectangle intersects the current viewport are fetched.
- Optics R/H/V transform rendering uses a shared GPU `mat3` path in vertex shaders (tile program and point program). The matrix is recomputed from current optics state and image center in NDC (`T(c) * M * T(-c)`) and uploaded for draw passes.
- Tile draw UV coordinates remain fixed (`[0,0, 1,0, 0,1, 1,1]`); transform behavior is applied in vertex space.
- Culling remains JS-side and uses inverse-viewport mapping into source-normalized space, so CPU culling and GPU placement stay mathematically aligned.
- Mask points are positioned from image-normalized coordinates into base NDC geometry, then transformed by the same vertex `mat3` used for tiles.
- After wheel zoom/pan and drag-pan movement, fit-level loading is re-evaluated so newly revealed visible tiles are requested even when the selected level does not change.
- Resize handling clamps pan/zoom, redraws, and re-evaluates fit level.
- Canvas interaction styling is in `frontend/src/main.scss` with `touch-action: none` and crosshair cursor.
- Viewer input handlers emit telemetry with module-level `logEvent(...)` over the shared WebSocket.
- `PageUp`/`PageDown` optics transform cycling is bound once at module init on `document` keydown so it works independent of canvas focus across rerenders; handler ignores editable targets (`INPUT`, `TEXTAREA`, `SELECT`, contenteditable) and calls `preventDefault()` to suppress browser page scroll.
- Logged frontend events include `image_change`, document `focus` (`focusin`/`focusout`), and temporary mask interaction events (`mouse_click`, `mask_created`, `mask_removed`, `label_assigned`).
- Canvas left-click adds a mask point only if total pointer travel since `pointerdown` is ≤ `config.clickMaxDragPx` (default 10 CSS px); longer drags are treated as pan gestures and suppressed. `Shift+left-click` removes nearest mask within 10 CSS px. Right-click near a mask opens a floating label assignment menu.
- The canvas border color indicates viewer readiness/zoom resolution: yellow while the selected image is not yet ready in the viewer, green when `fitLevel < manifest.levels - 1` (below max tile resolution), and brown when at the finest level. Updated via CSS classes toggled on the canvas element. The yellow debug box-shadow is removed.
