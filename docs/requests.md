# Requests

## Accepted decisions

- **Sessions in-memory**: Session tokens are stored in a server-side in-memory map; not persisted to SQLite. A server restart invalidates all sessions. (2026-04-02)

- **Auth flow**: Session cookie is set on successful login; WebSocket is then opened per tab using the cookie for auth. The WS serves as both communication channel and tab identity. (2026-04-02)

- **Tasks dialog admin/non-admin**: Fields description, images, annotations, and checkmark are read-only for non-admin users; browse buttons and delete/new-task actions are hidden. Admin mode is determined server-side; the badge in the dialog header reflects it. (2026-04-05)

- **Task card accordion**: Only one task card is expanded at a time in the Tasks dialog. (2026-04-05)

- **Checkmark field**: The task checkmark field represents "single annotation file 'nemolab.json'" — a boolean flag, not a file path. (2026-04-05)

- **Task persistence API**: Backend persists tasks, tags, and hierarchical labels in SQLite and serves them via `/api/tasks` endpoints. Non-admin users may edit only task `status` and `comment`; tag replacement is allowed for non-admin; task delete and label replacement are admin-only. (2026-04-05)

- **Tasks dialog load source**: Tasks dialog loads tasks from backend `GET /api/tasks` on open; UI ordering follows backend `ord` (with `id` tie-break). (2026-04-05)

- **Tasks dialog role source**: Tasks dialog admin/non-admin mode is sourced from backend `GET /api/me` (`is_admin`), not from local client toggles. (2026-04-05)

- **Frontend task persistence flow**: Task scalar edits, tag updates, label updates, create, and delete actions are sent to backend task endpoints immediately from the Tasks dialog. (2026-04-05)

- **Tasks dialog operation feedback**: Tasks dialog shows loading/saving state indicators and displays backend load/save failures as an inline error banner. (2026-04-05)

- **Task ordering persistence**: Admin users can reorder tasks in the dialog with up/down controls; frontend persists resulting order via updated `ord` values on task `PUT` calls. (2026-04-05)

- **Error banner lifecycle**: Tasks dialog inline error banners are cleared automatically after a subsequent successful load or save operation. (2026-04-05)

- **Task path directory browser**: In admin mode, browse buttons on task `images` and `annotations` open a directory-browser modal backed by `GET /api/dirs?path=...`; selecting a path applies it to the field and persists via the existing blur/save flow. (2026-04-05)

- **On-demand image list + prefetch tiling**: Backend derives task image lists from `task.images`, computes image hash as SHA-256 of canonical absolute file path, pushes `image_list` over WS, and handles `prefetch`/`image_ready` flow. `/images/{hash}/manifest.json` and `/images/{hash}/tiles/{z}/{x}_{y}.png` are cache-only HTTP reads; tile generation happens via WS prefetch processing. (2026-04-05)
