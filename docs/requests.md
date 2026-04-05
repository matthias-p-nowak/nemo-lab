# Requests

## Accepted decisions

- **Sessions in-memory**: Session tokens are stored in a server-side in-memory map; not persisted to SQLite. A server restart invalidates all sessions. (2026-04-02)

- **Auth flow**: Session cookie is set on successful login; WebSocket is then opened per tab using the cookie for auth. The WS serves as both communication channel and tab identity. (2026-04-02)

- **Tasks dialog admin/non-admin**: Fields description, images, annotations, and checkmark are read-only for non-admin users; browse buttons and delete/new-task actions are hidden. Admin mode is determined server-side; the badge in the dialog header reflects it. (2026-04-05)

- **Task card accordion**: Only one task card is expanded at a time in the Tasks dialog. (2026-04-05)

- **Checkmark field**: The task checkmark field represents "single annotation file 'nemolab.json'" — a boolean flag, not a file path. (2026-04-05)
