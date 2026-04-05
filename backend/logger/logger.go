package logger

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const maxFiles = 20

// Logger writes JSONL entries to a single session log file.
type Logger struct {
	mu sync.Mutex
	f  *os.File
}

// New creates logsDir, enforces file cap, and opens a new session log file.
func New(logsDir string, now time.Time) (*Logger, error) {
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return nil, err
	}

	entries, err := filepath.Glob(filepath.Join(logsDir, "*.jsonl"))
	if err != nil {
		return nil, err
	}
	sort.Strings(entries)
	for len(entries) >= maxFiles {
		if err := os.Remove(entries[0]); err != nil {
			return nil, err
		}
		entries = entries[1:]
	}

	name := fmt.Sprintf("%02d-%02d-%02d-%02d.jsonl", now.Day(), now.Hour(), now.Minute(), now.Second())
	f, err := os.Create(filepath.Join(logsDir, name))
	if err != nil {
		return nil, err
	}

	return &Logger{f: f}, nil
}

// Append writes one JSON object as a JSONL line.
func (l *Logger) Append(entry map[string]any) error {
	b, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	_, err = l.f.Write(b)
	return err
}

// Close closes the underlying log file.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}

// StateTracer tracks the last-seen state per item and only appends an entry
// when the state changes, avoiding repetitive log noise.
type StateTracer struct {
	mu     sync.Mutex
	states map[string]string
	logger *Logger
}

// NewStateTracer returns a StateTracer backed by the given Logger.
func NewStateTracer(l *Logger) *StateTracer {
	return &StateTracer{
		states: make(map[string]string),
		logger: l,
	}
}

// Trace logs {type:"trace_state", item, state} only when state differs from
// the previously recorded value for item. Safe for concurrent use.
func (t *StateTracer) Trace(item, state string) error {
	t.mu.Lock()
	prev, ok := t.states[item]
	if ok && prev == state {
		t.mu.Unlock()
		return nil
	}
	t.states[item] = state
	t.mu.Unlock()

	return t.logger.Append(map[string]any{
		"type":  "trace_state",
		"ts":    time.Now().Format(time.RFC3339),
		"item":  item,
		"state": state,
	})
}
