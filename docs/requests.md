# Requests

## Accepted decisions

- **Sessions in-memory**: Session tokens are stored in a server-side in-memory map; not persisted to SQLite. A server restart invalidates all sessions. (2026-04-02)

- **Auth flow**: Session cookie is set on successful login; WebSocket is then opened per tab using the cookie for auth. The WS serves as both communication channel and tab identity. (2026-04-02)
