package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"

	"golang.org/x/crypto/bcrypt"
)

const sessionCookieName = "nemo_session"

type contextKey string

const usernameContextKey contextKey = "username"

var (
	sessionsMu sync.RWMutex
	sessions   = map[string]int64{}
)

// Middleware enforces cookie or Basic Auth authentication for all routes.
func Middleware(db *sql.DB, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if username, ok := authenticateByCookie(db, r); ok {
			next.ServeHTTP(w, r.WithContext(withUsername(r.Context(), username)))
			return
		}

		username, password, ok := r.BasicAuth()
		if !ok {
			unauthorized(w)
			return
		}
		if username == "" {
			unauthorized(w)
			return
		}

		userID, verifiedUsername, err := verifyOrCreateUser(db, username, password)
		if err != nil {
			unauthorized(w)
			return
		}

		token, err := newSessionToken()
		if err != nil {
			http.Error(w, "failed to create session", http.StatusInternalServerError)
			return
		}

		sessionsMu.Lock()
		sessions[token] = userID
		sessionsMu.Unlock()

		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookieName,
			Value:    token,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})

		next.ServeHTTP(w, r.WithContext(withUsername(r.Context(), verifiedUsername)))
	})
}

// UsernameFromRequest returns the authenticated username set by the middleware.
func UsernameFromRequest(r *http.Request) string {
	username, _ := r.Context().Value(usernameContextKey).(string)
	return username
}

// ValidSessionToken reports whether a session token exists in memory.
func ValidSessionToken(token string) bool {
	sessionsMu.RLock()
	defer sessionsMu.RUnlock()
	_, ok := sessions[token]
	return ok
}

// UsernameFromSessionToken resolves username for an in-memory session token.
func UsernameFromSessionToken(db *sql.DB, token string) (string, bool) {
	if token == "" {
		return "", false
	}
	sessionsMu.RLock()
	userID, ok := sessions[token]
	sessionsMu.RUnlock()
	if !ok {
		return "", false
	}
	var username string
	if err := db.QueryRow("SELECT username FROM users WHERE id = ?", userID).Scan(&username); err != nil {
		return "", false
	}
	return username, true
}

func withUsername(ctx context.Context, username string) context.Context {
	return context.WithValue(ctx, usernameContextKey, username)
}

func authenticateByCookie(db *sql.DB, r *http.Request) (string, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return "", false
	}

	sessionsMu.RLock()
	userID, ok := sessions[cookie.Value]
	sessionsMu.RUnlock()
	if !ok {
		return "", false
	}

	var username string
	if err := db.QueryRow("SELECT username FROM users WHERE id = ?", userID).Scan(&username); err != nil {
		return "", false
	}

	return username, true
}

func verifyOrCreateUser(db *sql.DB, username, password string) (int64, string, error) {
	var (
		userID int64
		hash   string
	)

	err := db.QueryRow("SELECT id, password FROM users WHERE username = ?", username).Scan(&userID, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		createdHash, hashErr := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if hashErr != nil {
			return 0, "", hashErr
		}

		result, insertErr := db.Exec("INSERT INTO users(username, password) VALUES (?, ?)", username, string(createdHash))
		if insertErr != nil {
			return 0, "", insertErr
		}

		id, idErr := result.LastInsertId()
		if idErr != nil {
			return 0, "", idErr
		}

		return id, username, nil
	}
	if err != nil {
		return 0, "", err
	}

	if compareErr := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); compareErr != nil {
		return 0, "", compareErr
	}

	return userID, username, nil
}

func newSessionToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="Nemo-Lab"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}
