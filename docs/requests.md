# Requests

## Accepted decisions

- **Auth flow**: Session cookie is set on successful login; WebSocket is then opened per tab using the cookie for auth. The WS serves as both communication channel and tab identity. (2026-04-02)
