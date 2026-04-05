package tasks

import (
	"database/sql"
	"path/filepath"
	"testing"

	dblib "github.com/matthias-p-nowak/nemo-lab/db"
)

func TestTaskLifecycleWithTagsAndLabels(t *testing.T) {
	db := openTestDB(t)
	t.Cleanup(func() { _ = db.Close() })

	task1 := Task{
		ID:          "t1",
		Ord:         1,
		Description: "first task",
		Status:      "new",
		Images:      "/img",
		Annotations: "/ann",
		Checkmark:   true,
		Comment:     "c1",
	}
	task2 := Task{
		ID:          "t2",
		Ord:         0,
		Description: "second task",
		Status:      "doing",
		Images:      "",
		Annotations: "",
		Checkmark:   false,
		Comment:     "c2",
	}

	if err := Upsert(db, task1); err != nil {
		t.Fatalf("upsert task1: %v", err)
	}
	if err := Upsert(db, task2); err != nil {
		t.Fatalf("upsert task2: %v", err)
	}

	if err := ReplaceTags(db, "t1", []string{"alpha", "beta"}); err != nil {
		t.Fatalf("replace tags: %v", err)
	}
	if err := ReplaceLabels(db, "t1", []LabelNode{
		{
			ID:   "l1",
			Text: "root",
			Children: []LabelNode{
				{ID: "l2", Text: "child-a"},
				{ID: "l3", Text: "child-b"},
			},
		},
		{ID: "l4", Text: "root-2"},
	}); err != nil {
		t.Fatalf("replace labels: %v", err)
	}

	got, ok, err := Get(db, "t1")
	if err != nil {
		t.Fatalf("get task1: %v", err)
	}
	if !ok {
		t.Fatalf("expected task1 to exist")
	}
	if got.Description != "first task" || got.Status != "new" || !got.Checkmark {
		t.Fatalf("unexpected task1 scalar fields: %+v", got)
	}
	if len(got.Tags) != 2 || got.Tags[0] != "alpha" || got.Tags[1] != "beta" {
		t.Fatalf("unexpected tags: %#v", got.Tags)
	}
	if len(got.Labels) != 2 || got.Labels[0].ID != "l1" || got.Labels[1].ID != "l4" {
		t.Fatalf("unexpected root labels: %#v", got.Labels)
	}
	if len(got.Labels[0].Children) != 2 || got.Labels[0].Children[0].ID != "l2" || got.Labels[0].Children[1].ID != "l3" {
		t.Fatalf("unexpected child labels: %#v", got.Labels[0].Children)
	}

	list, err := List(db)
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(list))
	}
	if list[0].ID != "t2" || list[1].ID != "t1" {
		t.Fatalf("unexpected task ordering by ord: %#v", list)
	}

	if err := Delete(db, "t1"); err != nil {
		t.Fatalf("delete task1: %v", err)
	}
	_, ok, err = Get(db, "t1")
	if err != nil {
		t.Fatalf("get task1 after delete: %v", err)
	}
	if ok {
		t.Fatalf("expected task1 to be deleted")
	}
	var tagCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM task_tags WHERE task_id = ?", "t1").Scan(&tagCount); err != nil {
		t.Fatalf("count tags: %v", err)
	}
	if tagCount != 0 {
		t.Fatalf("expected cascade delete tags, got %d", tagCount)
	}
	var labelCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM task_labels WHERE task_id = ?", "t1").Scan(&labelCount); err != nil {
		t.Fatalf("count labels: %v", err)
	}
	if labelCount != 0 {
		t.Fatalf("expected cascade delete labels, got %d", labelCount)
	}
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks-test.db")
	db, err := dblib.Open(path)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	return db
}
