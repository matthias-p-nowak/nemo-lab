package main

import (
	"database/sql"
	"log"
	"net/http"

	"github.com/matthias-p-nowak/nemo-lab/auth"
	"github.com/matthias-p-nowak/nemo-lab/config"
	"github.com/matthias-p-nowak/nemo-lab/db"
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
	mux.Handle("/ws", ws.NewHandler(sqlDB))
	mux.Handle("/", http.FileServer(http.Dir(cfg.StaticDir)))

	handler := auth.Middleware(sqlDB, mux)
	log.Printf("listening on %s", cfg.ListenAddr)
	if err := http.ListenAndServe(cfg.ListenAddr, handler); err != nil {
		log.Fatalf("server error: %v", err)
	}
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
