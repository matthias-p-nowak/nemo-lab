package db

import (
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

const currentSchemaVersion = 3

// Open opens the sqlite database and ensures schema is initialized/migrated.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err = db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err = db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		_ = db.Close()
		return nil, err
	}

	if err := initialize(db); err != nil {
		_ = db.Close()
		return nil, err
	}

	return db, nil
}

func initialize(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER NOT NULL
		);
	`); err != nil {
		return err
	}

	if _, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id       INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT    NOT NULL UNIQUE,
			password TEXT    NOT NULL,
			is_admin INTEGER NOT NULL DEFAULT 0
		);
	`); err != nil {
		return err
	}
	if _, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS tasks (
			id          TEXT    PRIMARY KEY,
			ord         INTEGER NOT NULL DEFAULT 0,
			description TEXT    NOT NULL DEFAULT '',
			status      TEXT    NOT NULL DEFAULT 'new',
			images      TEXT    NOT NULL DEFAULT '',
			annotations TEXT    NOT NULL DEFAULT '',
			checkmark   INTEGER NOT NULL DEFAULT 0,
			comment     TEXT    NOT NULL DEFAULT ''
		);
	`); err != nil {
		return err
	}
	if _, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS task_tags (
			task_id TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			ord     INTEGER NOT NULL DEFAULT 0,
			tag     TEXT    NOT NULL,
			PRIMARY KEY (task_id, tag)
		);
	`); err != nil {
		return err
	}
	if _, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS task_labels (
			id        TEXT    PRIMARY KEY,
			task_id   TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			parent_id TEXT    REFERENCES task_labels(id) ON DELETE CASCADE,
			ord       INTEGER NOT NULL DEFAULT 0,
			text      TEXT    NOT NULL
		);
	`); err != nil {
		return err
	}
	if _, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS user_settings (
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			key     TEXT    NOT NULL,
			value   TEXT    NOT NULL,
			PRIMARY KEY (user_id, key)
		);
	`); err != nil {
		return err
	}

	var version int
	queryErr := tx.QueryRow("SELECT version FROM schema_version LIMIT 1").Scan(&version)
	if queryErr != nil {
		if errors.Is(queryErr, sql.ErrNoRows) {
			if _, err = tx.Exec("INSERT INTO schema_version(version) VALUES (?)", currentSchemaVersion); err != nil {
				return err
			}
		} else {
			return queryErr
		}
	} else {
		if version > currentSchemaVersion {
			return fmt.Errorf("schema version %d is newer than supported %d", version, currentSchemaVersion)
		}
		if version < currentSchemaVersion {
			if err = migrate(tx, version, currentSchemaVersion); err != nil {
				return err
			}
		}
	}

	if err = tx.Commit(); err != nil {
		return err
	}

	return nil
}

func migrate(tx *sql.Tx, from, to int) error {
	version := from
	for version < to {
		switch version {
		case 1:
			if _, err := tx.Exec(`UPDATE schema_version SET version = 2`); err != nil {
				return err
			}
			version = 2
		case 2:
			if _, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS user_settings (
					user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					key     TEXT    NOT NULL,
					value   TEXT    NOT NULL,
					PRIMARY KEY (user_id, key)
				);
			`); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE schema_version SET version = 3`); err != nil {
				return err
			}
			version = 3
		default:
			return fmt.Errorf("no migration available from version %d", version)
		}
	}

	return nil
}
