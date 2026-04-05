package ws

import (
	"database/sql"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/matthias-p-nowak/nemo-lab/auth"
	"github.com/matthias-p-nowak/nemo-lab/logger"
	"golang.org/x/net/websocket"
)

type connState struct {
	count        int
	activeTaskID string
}

var (
	connectionsMu sync.Mutex
	connections   = map[string]*connState{}
)

// NewHandler builds the /ws handler and validates session cookies before upgrade.
func NewHandler(db *sql.DB, logsDir string) http.HandlerFunc {
	_ = db

	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("nemo_session")
		if err != nil || !auth.ValidSessionToken(cookie.Value) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		websocket.Handler(func(conn *websocket.Conn) {
			defer conn.Close()

			lgr, loggerErr := logger.New(logsDir, time.Now())
			if loggerErr != nil {
				log.Printf("ws logger init failed: %v", loggerErr)
				lgr = nil
			}
			if lgr != nil {
				_ = lgr.Append(map[string]any{
					"type":         "connect",
					"ts":           time.Now().Format(time.RFC3339),
					"token_prefix": tokenPrefix(cookie.Value),
				})
			}

			connectionsMu.Lock()
			if connections[cookie.Value] == nil {
				connections[cookie.Value] = &connState{}
			}
			connections[cookie.Value].count++
			active := connections[cookie.Value].count
			connectionsMu.Unlock()
			log.Printf("ws connect token=%s active=%d", cookie.Value, active)

			defer func() {
				connectionsMu.Lock()
				if s := connections[cookie.Value]; s != nil && s.count > 1 {
					s.count--
				} else {
					delete(connections, cookie.Value)
				}
				remaining := 0
				if s := connections[cookie.Value]; s != nil {
					remaining = s.count
				}
				connectionsMu.Unlock()
				log.Printf("ws disconnect token=%s active=%d", cookie.Value, remaining)

				if lgr != nil {
					_ = lgr.Append(map[string]any{
						"type": "disconnect",
						"ts":   time.Now().Format(time.RFC3339),
					})
					_ = lgr.Close()
				}
			}()

			for {
				var msg struct {
					Type  string         `json:"type"`
					Entry map[string]any `json:"entry"`
				}
				if err := websocket.JSON.Receive(conn, &msg); err != nil {
					break
				}
				switch msg.Type {
				case "log":
					if lgr != nil {
						_ = lgr.Append(msg.Entry)
					}
				case "set_active_task":
					taskID, _ := msg.Entry["task_id"].(string)
					connectionsMu.Lock()
					if s := connections[cookie.Value]; s != nil {
						s.activeTaskID = taskID
					}
					connectionsMu.Unlock()
					if lgr != nil {
						_ = lgr.Append(msg.Entry)
					}
				}
			}
		}).ServeHTTP(w, r)
	}
}

// tokenPrefix returns the first up-to-8 characters for safe log correlation.
func tokenPrefix(token string) string {
	if len(token) <= 8 {
		return token
	}
	return token[:8]
}
