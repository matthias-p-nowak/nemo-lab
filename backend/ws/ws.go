package ws

import (
	"database/sql"
	"io"
	"log"
	"net/http"
	"sync"

	"github.com/matthias-p-nowak/nemo-lab/auth"
	"golang.org/x/net/websocket"
)

var (
	connectionsMu sync.Mutex
	connections   = map[string]int{}
)

// NewHandler builds the /ws handler and validates session cookies before upgrade.
func NewHandler(db *sql.DB) http.HandlerFunc {
	_ = db

	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("nemo_session")
		if err != nil || !auth.ValidSessionToken(cookie.Value) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		websocket.Handler(func(conn *websocket.Conn) {
			defer conn.Close()

			connectionsMu.Lock()
			connections[cookie.Value]++
			active := connections[cookie.Value]
			connectionsMu.Unlock()
			log.Printf("ws connect token=%s active=%d", cookie.Value, active)

			defer func() {
				connectionsMu.Lock()
				if connections[cookie.Value] > 1 {
					connections[cookie.Value]--
				} else {
					delete(connections, cookie.Value)
				}
				remaining := connections[cookie.Value]
				connectionsMu.Unlock()
				log.Printf("ws disconnect token=%s active=%d", cookie.Value, remaining)
			}()

			_, _ = io.Copy(io.Discard, conn)
		}).ServeHTTP(w, r)
	}
}
