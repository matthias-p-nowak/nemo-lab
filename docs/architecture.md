# Nemo-Lab Architecture

## Backend runtime wiring

- `backend/cmd/server/main.go` loads config from `nemo.toml`, opens SQLite, syncs `users.is_admin` from config admins, registers routes, wraps all routes with auth middleware, and starts the HTTP server.
- Routes:
  - `/ws` handled by `backend/ws`.
  - `/` served by static file server rooted at configured `static_dir`.

## Config

- Implemented in `backend/config/config.go` using TOML (`BurntSushi/toml`).
- Fields: `listen_addr`, `static_dir`, `db_path`, `admins`.
- Defaults if missing: `:7255`, `dist`, `nemo.db`, `[]`.

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
- Current behavior is a connectivity stub: keep connection open, log connect/disconnect.
