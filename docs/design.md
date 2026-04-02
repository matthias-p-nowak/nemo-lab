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

- TOML file
- Contains list of admin users

### Database

- SQLite3
- Schema has a version field
- Automatically migrates from earlier versions

### Authentication

- HTTP 401 triggers the browser's native login dialog
- Any unknown user is auto-created; the password used at first login is stored (bcrypt)
- On successful authentication:
  - A session cookie is set (used for re-authentication on reconnect)
  - A WebSocket connection is established per tab:
    - Serves as the bidirectional communication channel
    - Serves as tab identification
