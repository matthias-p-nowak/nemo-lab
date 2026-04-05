package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/matthias-p-nowak/nemo-lab/auth"
	dblib "github.com/matthias-p-nowak/nemo-lab/db"
	"github.com/matthias-p-nowak/nemo-lab/tasks"
)

func TestMeEndpointReflectsServerAdminFlag(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	handler := withAuthTasksMux(db)
	resp := doJSONRequest(t, handler, http.MethodGet, "/api/me", "alice", "pw", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected me endpoint success, got=%d", resp.Code)
	}
	var before struct {
		Username string `json:"username"`
		IsAdmin  bool   `json:"is_admin"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &before); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	if before.Username != "alice" || before.IsAdmin {
		t.Fatalf("unexpected me response before admin update: %+v", before)
	}

	if _, err := db.Exec("UPDATE users SET is_admin = 1 WHERE username = ?", "alice"); err != nil {
		t.Fatalf("promote alice: %v", err)
	}
	resp = doJSONRequest(t, handler, http.MethodGet, "/api/me", "alice", "pw", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected me endpoint success after promotion, got=%d", resp.Code)
	}
	var after struct {
		Username string `json:"username"`
		IsAdmin  bool   `json:"is_admin"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode me response after promotion: %v", err)
	}
	if after.Username != "alice" || !after.IsAdmin {
		t.Fatalf("unexpected me response after admin update: %+v", after)
	}
}

func TestTaskUpsertNonAdminOnlyChangesStatusAndComment(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	if err := tasks.Upsert(db, tasks.Task{
		ID:          "t1",
		Ord:         1,
		Description: "original",
		Status:      "new",
		Images:      "/img",
		Annotations: "/ann",
		Checkmark:   true,
		Comment:     "old",
	}); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	handler := withAuthTasksMux(db)
	body := tasks.Task{
		Description: "hacked",
		Status:      "done",
		Images:      "/changed",
		Annotations: "/changed-ann",
		Checkmark:   false,
		Comment:     "updated by non-admin",
	}
	resp := doJSONRequest(t, handler, http.MethodPut, "/api/tasks/t1", "bob", "pw", body)
	if resp.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d", resp.Code)
	}

	got, ok, err := tasks.Get(db, "t1")
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if !ok {
		t.Fatalf("expected task to exist")
	}
	if got.Description != "original" || got.Images != "/img" || got.Annotations != "/ann" || !got.Checkmark {
		t.Fatalf("non-admin changed restricted fields: %+v", got)
	}
	if got.Status != "done" || got.Comment != "updated by non-admin" {
		t.Fatalf("non-admin changes to allowed fields not applied: %+v", got)
	}
}

func TestTaskLabelsEndpointAdminOnly(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	if err := tasks.Upsert(db, tasks.Task{ID: "t1", Status: "new"}); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	handler := withAuthTasksMux(db)

	nonAdminResp := doJSONRequest(
		t, handler, http.MethodPut, "/api/tasks/t1/labels", "bob", "pw",
		[]tasks.LabelNode{{ID: "l1", Text: "x"}},
	)
	if nonAdminResp.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden for non-admin, got=%d", nonAdminResp.Code)
	}

	// Create alice via authenticated request, then mark as admin server-side.
	listResp := doJSONRequest(t, handler, http.MethodGet, "/api/tasks", "alice", "pw", nil)
	if listResp.Code != http.StatusOK {
		t.Fatalf("create alice session failed: got=%d", listResp.Code)
	}
	if _, err := db.Exec("UPDATE users SET is_admin = 1 WHERE username = ?", "alice"); err != nil {
		t.Fatalf("promote alice to admin: %v", err)
	}

	adminResp := doJSONRequest(
		t, handler, http.MethodPut, "/api/tasks/t1/labels", "alice", "pw",
		[]tasks.LabelNode{{ID: "l1", Text: "root", Children: []tasks.LabelNode{{ID: "l2", Text: "child"}}}},
	)
	if adminResp.Code != http.StatusOK {
		t.Fatalf("expected admin labels update success, got=%d body=%s", adminResp.Code, adminResp.Body.String())
	}

	got, ok, err := tasks.Get(db, "t1")
	if err != nil {
		t.Fatalf("get task after labels update: %v", err)
	}
	if !ok {
		t.Fatalf("expected task to exist")
	}
	if len(got.Labels) != 1 || got.Labels[0].ID != "l1" || len(got.Labels[0].Children) != 1 || got.Labels[0].Children[0].ID != "l2" {
		t.Fatalf("unexpected labels: %#v", got.Labels)
	}
}

func TestTaskDeleteEndpointAdminOnly(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	if err := tasks.Upsert(db, tasks.Task{ID: "t1", Status: "new"}); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	handler := withAuthTasksMux(db)

	nonAdminResp := doJSONRequest(t, handler, http.MethodDelete, "/api/tasks/t1", "bob", "pw", nil)
	if nonAdminResp.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden for non-admin delete, got=%d", nonAdminResp.Code)
	}

	// Create admin user and promote.
	listResp := doJSONRequest(t, handler, http.MethodGet, "/api/tasks", "alice", "pw", nil)
	if listResp.Code != http.StatusOK {
		t.Fatalf("create alice session failed: got=%d", listResp.Code)
	}
	if _, err := db.Exec("UPDATE users SET is_admin = 1 WHERE username = ?", "alice"); err != nil {
		t.Fatalf("promote alice to admin: %v", err)
	}

	adminResp := doJSONRequest(t, handler, http.MethodDelete, "/api/tasks/t1", "alice", "pw", nil)
	if adminResp.Code != http.StatusNoContent {
		t.Fatalf("expected no content for admin delete, got=%d", adminResp.Code)
	}
	if _, ok, err := tasks.Get(db, "t1"); err != nil {
		t.Fatalf("get task after delete: %v", err)
	} else if ok {
		t.Fatalf("expected task to be deleted")
	}
}

func withAuthTasksMux(db *sql.DB) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", makeMeHandler(db))
	mux.HandleFunc("GET /api/tasks", makeTasksListHandler(db))
	mux.HandleFunc("PUT /api/tasks/{id}", makeTaskUpsertHandler(db))
	mux.HandleFunc("DELETE /api/tasks/{id}", makeTaskDeleteHandler(db))
	mux.HandleFunc("PUT /api/tasks/{id}/tags", makeTaskTagsHandler(db))
	mux.HandleFunc("PUT /api/tasks/{id}/labels", makeTaskLabelsHandler(db))
	return auth.Middleware(db, mux)
}

func doJSONRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	username string,
	password string,
	body any,
) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.SetBasicAuth(username, password)
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, req)
	return resp
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "server-test.db")
	db, err := dblib.Open(path)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	return db
}
