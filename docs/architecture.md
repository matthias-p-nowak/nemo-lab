# Nemo-Lab Architecture

## Backend runtime wiring

- `backend/cmd/server/main.go` loads config from `nemo.toml`, opens SQLite, syncs `users.is_admin` from config admins, registers routes, wraps all routes with auth middleware, and starts the HTTP server.
- Routes:
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
- Current schema version is `1`; newer DB versions are rejected.

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
- Resize handling clamps pan/zoom, redraws, and re-evaluates fit level.
- Canvas interaction styling is in `frontend/src/main.scss` with `touch-action: none` and grab/grabbing cursors.
- Viewer input handlers emit telemetry with module-level `logEvent(...)` over the shared WebSocket.
- Logged frontend events include `wheel`, `pointer` (`down`/`up`/`move_first`), `pan_zoom` (via `traceState`, deduplicated), `image_change`, document `focus` (`focusin`/`focusout`), and `tile_placed` (level, `tx`, `ty`, and CSS-pixel placement `x`, `y`, `width`, `height` when a tile is uploaded and placed).
- Canvas click adds an annotation only if total pointer travel since `pointerdown` is ≤ `config.clickMaxDragPx` (default 10 CSS px); longer drags are treated as pan gestures and suppressed.
- The canvas border color indicates zoom resolution: green when `fitLevel < manifest.levels - 1` (below max tile resolution), brown when at the finest level. Updated via a CSS class toggled on the canvas element after each zoom change. The yellow debug box-shadow is removed.
- The entrance animation duration is 200 ms.
