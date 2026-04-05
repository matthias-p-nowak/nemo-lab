package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/matthias-p-nowak/nemo-lab/auth"
	"github.com/matthias-p-nowak/nemo-lab/config"
	"github.com/matthias-p-nowak/nemo-lab/db"
	"github.com/matthias-p-nowak/nemo-lab/tasks"
	"github.com/matthias-p-nowak/nemo-lab/ws"
)

func main() {
	cfg, err := config.Load("nemo.toml")
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	sqlDB, err := db.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer sqlDB.Close()

	if err := syncAdmins(sqlDB, cfg.Admins); err != nil {
		log.Fatalf("sync admins: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", makeMeHandler(sqlDB))
	mux.HandleFunc("GET /api/tasks", makeTasksListHandler(sqlDB))
	mux.HandleFunc("PUT /api/tasks/{id}", makeTaskUpsertHandler(sqlDB))
	mux.HandleFunc("DELETE /api/tasks/{id}", makeTaskDeleteHandler(sqlDB))
	mux.HandleFunc("PUT /api/tasks/{id}/tags", makeTaskTagsHandler(sqlDB))
	mux.HandleFunc("PUT /api/tasks/{id}/labels", makeTaskLabelsHandler(sqlDB))
	mux.HandleFunc("GET /api/dirs", makeDirsHandler())
	mux.Handle("/ws", ws.NewHandler(sqlDB, cfg.LogsDir))
	mux.Handle("/images/", http.StripPrefix("/images/", http.FileServer(http.Dir("images"))))
	mux.Handle("/", http.FileServer(http.Dir(cfg.StaticDir)))

	handler := auth.Middleware(sqlDB, mux)
	log.Printf("listening on %s", cfg.ListenAddr)
	if err := http.ListenAndServe(cfg.ListenAddr, handler); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func makeMeHandler(db *sql.DB) http.HandlerFunc {
	type meResponse struct {
		Username string `json:"username"`
		IsAdmin  bool   `json:"is_admin"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		taskAPILog(db, r, "get_me:start")
		writeJSON(w, http.StatusOK, meResponse{
			Username: auth.UsernameFromRequest(r),
			IsAdmin:  isAdmin(db, r),
		})
		taskAPILog(db, r, "get_me:ok")
	}
}

func isAdmin(db *sql.DB, r *http.Request) bool {
	username := auth.UsernameFromRequest(r)
	if username == "" {
		return false
	}
	var admin int
	if err := db.QueryRow("SELECT is_admin FROM users WHERE username = ?", username).Scan(&admin); err != nil {
		return false
	}
	return admin == 1
}

func makeTasksListHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		taskAPILog(db, r, "list:start")
		list, err := tasks.List(db)
		if err != nil {
			taskAPILog(db, r, fmt.Sprintf("list:error err=%v", err))
			http.Error(w, "list tasks failed", http.StatusInternalServerError)
			return
		}
		if list == nil {
			list = []tasks.Task{}
		}
		writeJSON(w, http.StatusOK, list)
		taskAPILog(db, r, fmt.Sprintf("list:ok count=%d", len(list)))
	}
}

func makeTaskUpsertHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		taskAPILog(db, r, fmt.Sprintf("upsert:start id=%s", id))
		if id == "" {
			taskAPILog(db, r, "upsert:error missing id")
			http.Error(w, "missing id", http.StatusBadRequest)
			return
		}

		var body tasks.Task
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			taskAPILog(db, r, fmt.Sprintf("upsert:error decode id=%s err=%v", id, err))
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		body.ID = id

		if !isAdmin(db, r) {
			existing, ok, err := tasks.Get(db, id)
			if err != nil {
				taskAPILog(db, r, fmt.Sprintf("upsert:error load-existing id=%s err=%v", id, err))
				http.Error(w, "load existing task failed", http.StatusInternalServerError)
				return
			}
			if !ok {
				taskAPILog(db, r, fmt.Sprintf("upsert:error not-found id=%s", id))
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			existing.Status = body.Status
			existing.Comment = body.Comment
			body = existing
		}

		if err := tasks.Upsert(db, body); err != nil {
			taskAPILog(db, r, fmt.Sprintf("upsert:error persist id=%s err=%v", id, err))
			http.Error(w, "upsert task failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		taskAPILog(db, r, fmt.Sprintf("upsert:ok id=%s", id))
	}
}

func makeTaskDeleteHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		taskAPILog(db, r, fmt.Sprintf("delete:start id=%s", id))
		if !isAdmin(db, r) {
			taskAPILog(db, r, fmt.Sprintf("delete:forbidden id=%s", id))
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if err := tasks.Delete(db, id); err != nil {
			taskAPILog(db, r, fmt.Sprintf("delete:error id=%s err=%v", id, err))
			http.Error(w, "delete task failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		taskAPILog(db, r, fmt.Sprintf("delete:ok id=%s", id))
	}
}

func makeTaskTagsHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		taskAPILog(db, r, fmt.Sprintf("tags_replace:start id=%s", id))
		_, ok, err := tasks.Get(db, id)
		if err != nil {
			taskAPILog(db, r, fmt.Sprintf("tags_replace:error load-existing id=%s err=%v", id, err))
			http.Error(w, "load existing task failed", http.StatusInternalServerError)
			return
		}
		if !ok {
			taskAPILog(db, r, fmt.Sprintf("tags_replace:error not-found id=%s", id))
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		var body struct {
			Tags []string `json:"tags"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			taskAPILog(db, r, fmt.Sprintf("tags_replace:error decode id=%s err=%v", id, err))
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}

		if err := tasks.ReplaceTags(db, id, body.Tags); err != nil {
			taskAPILog(db, r, fmt.Sprintf("tags_replace:error persist id=%s err=%v", id, err))
			http.Error(w, "replace tags failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		taskAPILog(db, r, fmt.Sprintf("tags_replace:ok id=%s count=%d", id, len(body.Tags)))
	}
}

func makeTaskLabelsHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		taskAPILog(db, r, fmt.Sprintf("labels_replace:start id=%s", id))
		if !isAdmin(db, r) {
			taskAPILog(db, r, fmt.Sprintf("labels_replace:forbidden id=%s", id))
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		_, ok, err := tasks.Get(db, id)
		if err != nil {
			taskAPILog(db, r, fmt.Sprintf("labels_replace:error load-existing id=%s err=%v", id, err))
			http.Error(w, "load existing task failed", http.StatusInternalServerError)
			return
		}
		if !ok {
			taskAPILog(db, r, fmt.Sprintf("labels_replace:error not-found id=%s", id))
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		var nodes []tasks.LabelNode
		if err := json.NewDecoder(r.Body).Decode(&nodes); err != nil {
			taskAPILog(db, r, fmt.Sprintf("labels_replace:error decode id=%s err=%v", id, err))
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}

		if err := tasks.ReplaceLabels(db, id, nodes); err != nil {
			taskAPILog(db, r, fmt.Sprintf("labels_replace:error persist id=%s err=%v", id, err))
			http.Error(w, "replace labels failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		taskAPILog(db, r, fmt.Sprintf("labels_replace:ok id=%s roots=%d", id, len(nodes)))
	}
}

func makeDirsHandler() http.HandlerFunc {
	type dirsResponse struct {
		Dirs []string `json:"dirs"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/"
		}
		dirs, err := listDirs(path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, dirsResponse{Dirs: dirs})
	}
}

func listDirs(path string) ([]string, error) {
	clean := filepath.Clean(path)
	info, err := os.Stat(clean)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		return []string{}, nil
	}

	entries, err := os.ReadDir(clean)
	if err != nil {
		return nil, err
	}
	dirs := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, entry.Name())
		}
	}
	sort.Strings(dirs)
	return dirs, nil
}

func taskAPILog(db *sql.DB, r *http.Request, msg string) {
	log.Printf(
		"tasks_api %s method=%s path=%s user=%s admin=%t",
		msg,
		r.Method,
		r.URL.Path,
		auth.UsernameFromRequest(r),
		isAdmin(db, r),
	)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func syncAdmins(db *sql.DB, admins []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec("UPDATE users SET is_admin = 0"); err != nil {
		return err
	}

	for _, username := range admins {
		if _, err = tx.Exec("UPDATE users SET is_admin = 1 WHERE username = ?", username); err != nil {
			return err
		}
	}

	if err = tx.Commit(); err != nil {
		return err
	}
	return nil
}
