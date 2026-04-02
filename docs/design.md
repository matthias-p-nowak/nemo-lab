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
| `admins`      | []string | `[]`      | Usernames with admin privileges          |

Example `nemo.toml`:
```toml
listen_addr = ":7255"
static_dir  = "dist"
db_path     = "nemo.db"
admins      = ["ma"]
```

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
