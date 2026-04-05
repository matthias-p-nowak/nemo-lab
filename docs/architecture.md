# Nemo-Lab Architecture

## Backend runtime wiring

- `backend/cmd/server/main.go` loads config from `nemo.toml`, opens SQLite, syncs `users.is_admin` from config admins, registers routes, wraps all routes with auth middleware, and starts the HTTP server.
- Routes:
  - `/api/me` handled by `backend/cmd/server/main.go` and returns `username` + `is_admin` for the authenticated user.
  - `/api/tasks` handled by task handlers in `backend/cmd/server/main.go` backed by `backend/tasks`.
  - `/ws` handled by `backend/ws`.
  - `/` served by static file server rooted at configured `static_dir`.

## Config

- Implemented in `backend/config/config.go` using TOML (`BurntSushi/toml`).
- Fields: `listen_addr`, `static_dir`, `db_path`, `logs_dir`, `admins`.
- Defaults if missing: `:7255`, `dist`, `nemo.db`, `logs`, `[]`.

## Database

- Implemented in `backend/db/db.go` with pure-Go SQLite driver `modernc.org/sqlite`.
- `Open(path)` ensures schema exists and validates schema version.
- Schema includes:
  - `schema_version(version INTEGER NOT NULL)` single-row version tracking.
  - `users(id, username UNIQUE, password, is_admin)`.
  - `tasks(id, ord, description, status, images, annotations, checkmark, comment)`.
  - `task_tags(task_id, ord, tag)` with `ON DELETE CASCADE` to `tasks`.
  - `task_labels(id, task_id, parent_id, ord, text)` with cascading delete for task and label subtree removal.
- Current schema version is `2`; newer DB versions are rejected.
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
- Backend reads JSON WS messages and appends entries only for `{ "type": "log", "entry": { ... } }`.

## Tasks API

- Core task persistence logic is in `backend/tasks/tasks.go`.
- `tasks.List` and `tasks.Get` load task scalars and join tags/labels in application code.
- Label trees are stored flat (`task_labels`) and materialized via a tree builder keyed by `parent_id`.
- `tasks.ReplaceTags` and `tasks.ReplaceLabels` run in explicit transactions and replace complete sets.
- Route behavior in `backend/cmd/server/main.go`:
  - `GET /api/me`: returns authenticated username and admin flag from `users.is_admin`.
  - `GET /api/tasks`: list all tasks for any authenticated user (returns `[]` when empty, never `null`).
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

## Frontend image viewer

- Implemented in `frontend/src/main.ts` (`WebGLTileViewer`).
- Viewer state now tracks `zoom`, `offsetX`, and `offsetY` for interactive navigation.
- Initial image load sets pan/zoom to centered fit (`fitScaleForDimensions(manifest.width, manifest.height)`), then starts the existing level-0 entrance animation.
- Wheel and pointer behavior:
  - `Ctrl+wheel` zooms around cursor.
  - Wheel pans vertically; `Shift+wheel` pans horizontally.
  - Primary-pointer drag pans image.
- `Ctrl+wheel` zoom applies cursor-centered offset scaling using the actually applied (clamped) zoom ratio, preventing offset drift when zoom is already at min/max clamp.
- `clampPanZoom()` constrains zoom and offsets with a 20px overscroll pad and max zoom `2`, using ordered min/max bounds so pan remains available even when the zoomed image is larger than the canvas.
- Tile level selection (`pickFitLevel`) is based on current zoomed image target (`zoom * manifest dimension * dpr`), and `maybeChangeFitLevel()` reloads tiles when level changes.
- Fit-level tile streaming uses a monotonic load-batch generation token so stale async tile callbacks are ignored, including revisits to the same level after intermediate zoom changes.
- Fit-level tile requests are viewport-culled: only tiles whose level-space rectangle intersects the current viewport are fetched.
- After wheel zoom/pan and drag-pan movement, fit-level loading is re-evaluated so newly revealed visible tiles are requested even when the selected level does not change.
- Resize handling clamps pan/zoom, redraws, and re-evaluates fit level.
- Canvas interaction styling is in `frontend/src/main.scss` with `touch-action: none` and grab/grabbing cursors.
- Viewer input handlers emit telemetry with module-level `logEvent(...)` over the shared WebSocket.
- Logged frontend events: `image_change` and document `focus` (`focusin`/`focusout`).
- Canvas click adds an annotation only if total pointer travel since `pointerdown` is ≤ `config.clickMaxDragPx` (default 10 CSS px); longer drags are treated as pan gestures and suppressed.
- The canvas border color indicates zoom resolution: green when `fitLevel < manifest.levels - 1` (below max tile resolution), brown when at the finest level. Updated via a CSS class toggled on the canvas element after each zoom change. The yellow debug box-shadow is removed.
- The entrance animation duration is 200 ms.
