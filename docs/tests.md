# Tests

## Framework

### Backend unit tests

Go unit tests in `backend/`, co-located with source files (`*_test.go`). Run with:

```
go test ./...
```

from the `backend/` directory.

### Frontend / E2E tests

Playwright tests in `tests/`. Run with:

```
pytest tests/
```

Tests drive a real browser against a running backend instance. The backend is started as a subprocess fixture; the frontend is served from `dist/` (pre-built before test run).

Log files written to `logs/` during test sessions can be read and asserted on to verify backend-side event sequences without additional instrumentation.

## Backend tests

| Test | File | Description |
|------|------|-------------|
| Auth middleware — valid session | `auth/auth_test.go` | Request with valid session cookie passes through |
| Auth middleware — no credentials | `auth/auth_test.go` | Request with no cookie/header returns 401 |
| Auth middleware — wrong password | `auth/auth_test.go` | Basic auth with wrong password returns 401 |
| `/api/version` requires auth | `cmd/server/main_test.go` | Unauthenticated request returns 401 |
| `/api/version` returns string | `cmd/server/main_test.go` | Authenticated request returns JSON string |
| Annotation read — COCO | `annotations/annotations_test.go` | Plain COCO file parsed correctly |
| Annotation read — extended COCO | `annotations/annotations_test.go` | Nemolab sidecar fields preserved on read |
| Annotation read — LabelMe | `annotations/annotations_test.go` | LabelMe shapes converted to COCO polygon |
| Annotation write — polygon only | `annotations/annotations_test.go` | Output never contains RLE segmentation |
| `nemolab_mask_authors` — new mask | `ws/ws_annotations_test.go` | Author recorded for newly created mask |
| `nemolab_mask_authors` — overwrite on change | `ws/ws_annotations_test.go` | Author updated when mask is modified (last-writer-wins) |
| `nemolab_mask_authors` — removed on delete | `ws/ws_annotations_test.go` | Author entry removed when mask is deleted |
| `nemolab_authors` — comment author | `ws/ws_annotations_test.go` | Comment author updated on edit |

## Frontend / E2E tests (Playwright)

### To be implemented

| Test | Description |
|------|-------------|
| Login | Basic auth dialog appears; valid credentials grant access |
| Task open | Selecting a task loads the image list and displays first image |
| Image navigation | Prev/next buttons step through images; index field jump works |
| Point mask — place | Left-click places a point mask; annotation list updates |
| Point mask — remove | Shift+left-click removes nearest mask |
| Point mask — select/deselect | Double-click selects; Escape deselects; halo visible on selected |
| Bbox mask — place | Click-drag in bbox mode places a bbox; annotation list updates |
| Bbox mask — edit side | Double-click bbox, drag a side, verify updated coordinates |
| Bbox mask — auto mode switch | Double-clicking a bbox mask switches mode to "bounding box" |
| Freehand mask — self-intersecting stroke creates loop | Draw a figure-8 stroke; verify `freehand_finalize` log shows `new_loop_created` |
| Freehand mask — closed stroke creates loop | Draw a near-closed stroke; verify mask appears |
| Freehand mask — drop logged | Draw a degenerate stroke; verify `freehand_finalize` log shows a `drop_*` outcome |
| Mode shortcuts | Press `p`/`r`/`f` in canvas scope; verify mode toast and panel update |
| Label assignment | Right-click near mask; select label from context menu; verify outline color change |
| Comment — image | Type in image comment textarea; verify persisted in annotation file |
| Comment — annotation | Select mask; type in annotation comment; verify persisted |
| Author display | Edit comment as user A; verify "Last edited by A" shown |
| Mask author display | Place mask as user A; verify "by A" byline in annotation list |
| Annotation color stability | Delete a mask; verify remaining masks retain their colors |
| Max zoom | Zoom to maximum; verify canvas border turns brown and further scroll has no effect |
| Help dialog | Open Help from menu; verify four tabs render; Shortcuts tab contains shortcut table |
| Theme switch | Toggle light/dark; verify CSS variable change persists on reload |
| Right sidebar resize | Drag resize handle; verify width persists on reload |

### Log-based assertions

Tests that involve freehand mask placement should read the session log file after the action and assert on the `freehand_finalize` event:

- `outcome` is one of the `new_loop_*` values (not a `drop_*` value) for successful draws
- `self_intersections` matches the expected stroke complexity
- `existing_freehand_masks` reflects pre-existing mask count
