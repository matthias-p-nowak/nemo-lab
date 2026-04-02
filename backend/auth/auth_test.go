package auth

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	dblib "github.com/matthias-p-nowak/nemo-lab/db"
	"golang.org/x/crypto/bcrypt"
)

func TestMiddlewareAutoCreatesUser(t *testing.T) {
	clearSessionsForTests()

	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(UsernameFromRequest(r)))
	})

	handler := Middleware(db, next)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.SetBasicAuth("alice", "s3cret")
	resp := httptest.NewRecorder()

	handler.ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d", resp.Code)
	}
	if body := strings.TrimSpace(resp.Body.String()); body != "alice" {
		t.Fatalf("unexpected username in context: %q", body)
	}

	var storedHash string
	if err := db.QueryRow("SELECT password FROM users WHERE username = ?", "alice").Scan(&storedHash); err != nil {
		t.Fatalf("query user: %v", err)
	}
	if storedHash == "s3cret" {
		t.Fatalf("password stored in clear text")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(storedHash), []byte("s3cret")); err != nil {
		t.Fatalf("stored hash mismatch: %v", err)
	}
}

func TestMiddlewareRejectsWrongPassword(t *testing.T) {
	clearSessionsForTests()

	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := Middleware(db, next)

	goodReq := httptest.NewRequest(http.MethodGet, "/", nil)
	goodReq.SetBasicAuth("bob", "right-pass")
	goodResp := httptest.NewRecorder()
	handler.ServeHTTP(goodResp, goodReq)
	if goodResp.Code != http.StatusOK {
		t.Fatalf("seed request status: got=%d", goodResp.Code)
	}

	badReq := httptest.NewRequest(http.MethodGet, "/", nil)
	badReq.SetBasicAuth("bob", "wrong-pass")
	badResp := httptest.NewRecorder()
	handler.ServeHTTP(badResp, badReq)

	if badResp.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got=%d", badResp.Code)
	}
}

func TestMiddlewareSessionCookieRoundTrip(t *testing.T) {
	clearSessionsForTests()

	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(UsernameFromRequest(r)))
	})
	handler := Middleware(db, next)

	loginReq := httptest.NewRequest(http.MethodGet, "/", nil)
	loginReq.SetBasicAuth("carol", "pw")
	loginResp := httptest.NewRecorder()
	handler.ServeHTTP(loginResp, loginReq)
	if loginResp.Code != http.StatusOK {
		t.Fatalf("login request status: got=%d", loginResp.Code)
	}

	cookies := loginResp.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatalf("expected session cookie")
	}

	cookieReq := httptest.NewRequest(http.MethodGet, "/", nil)
	cookieReq.AddCookie(cookies[0])
	cookieResp := httptest.NewRecorder()
	handler.ServeHTTP(cookieResp, cookieReq)

	if cookieResp.Code != http.StatusOK {
		t.Fatalf("cookie request status: got=%d", cookieResp.Code)
	}
	if body := strings.TrimSpace(cookieResp.Body.String()); body != "carol" {
		t.Fatalf("unexpected username from cookie auth: %q", body)
	}
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := dblib.Open(":memory:")
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	return db
}

func clearSessionsForTests() {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	sessions = map[string]int64{}
}
