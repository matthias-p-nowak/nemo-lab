package tasks

import (
	"database/sql"
	"sort"
)

// LabelNode is one node in the nested task label tree.
type LabelNode struct {
	ID       string      `json:"id"`
	Text     string      `json:"text"`
	Children []LabelNode `json:"children"`
}

// Task is the persisted task model returned by the tasks API.
type Task struct {
	ID          string      `json:"id"`
	Ord         int         `json:"ord"`
	Description string      `json:"description"`
	Status      string      `json:"status"`
	Tags        []string    `json:"tags"`
	Images      string      `json:"images"`
	Annotations string      `json:"annotations"`
	Checkmark   bool        `json:"checkmark"`
	Comment     string      `json:"comment"`
	Labels      []LabelNode `json:"labels"`
}

type labelRow struct {
	id       string
	parentID sql.NullString
	ord      int
	text     string
}

// List returns all tasks ordered by ord with tags and nested labels populated.
func List(db *sql.DB) ([]Task, error) {
	rows, err := db.Query(`
		SELECT id, ord, description, status, images, annotations, checkmark, comment
		FROM tasks
		ORDER BY ord, id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Task
	for rows.Next() {
		var t Task
		var checkmark int
		if err := rows.Scan(
			&t.ID, &t.Ord, &t.Description, &t.Status, &t.Images, &t.Annotations, &checkmark, &t.Comment,
		); err != nil {
			return nil, err
		}
		t.Checkmark = checkmark != 0

		tags, err := loadTags(db, t.ID)
		if err != nil {
			return nil, err
		}
		t.Tags = tags

		labelRows, err := loadLabelRows(db, t.ID)
		if err != nil {
			return nil, err
		}
		t.Labels = buildLabelTree(labelRows)
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return out, nil
}

// Get returns one task by id with tags and nested labels.
func Get(db *sql.DB, id string) (Task, bool, error) {
	var (
		t         Task
		checkmark int
	)
	err := db.QueryRow(`
		SELECT id, ord, description, status, images, annotations, checkmark, comment
		FROM tasks
		WHERE id = ?
	`, id).Scan(
		&t.ID, &t.Ord, &t.Description, &t.Status, &t.Images, &t.Annotations, &checkmark, &t.Comment,
	)
	if err == sql.ErrNoRows {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, err
	}
	t.Checkmark = checkmark != 0

	tags, err := loadTags(db, t.ID)
	if err != nil {
		return Task{}, false, err
	}
	t.Tags = tags

	labelRows, err := loadLabelRows(db, t.ID)
	if err != nil {
		return Task{}, false, err
	}
	t.Labels = buildLabelTree(labelRows)

	return t, true, nil
}

// Upsert writes scalar task fields.
func Upsert(db *sql.DB, t Task) error {
	checkmark := 0
	if t.Checkmark {
		checkmark = 1
	}
	_, err := db.Exec(`
		INSERT INTO tasks(id, ord, description, status, images, annotations, checkmark, comment)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			ord = excluded.ord,
			description = excluded.description,
			status = excluded.status,
			images = excluded.images,
			annotations = excluded.annotations,
			checkmark = excluded.checkmark,
			comment = excluded.comment
	`, t.ID, t.Ord, t.Description, t.Status, t.Images, t.Annotations, checkmark, t.Comment)
	return err
}

// Delete removes one task.
func Delete(db *sql.DB, id string) error {
	_, err := db.Exec(`DELETE FROM tasks WHERE id = ?`, id)
	return err
}

// ReplaceTags replaces all tags for one task.
func ReplaceTags(db *sql.DB, taskID string, tags []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec(`DELETE FROM task_tags WHERE task_id = ?`, taskID); err != nil {
		return err
	}

	for i, tag := range tags {
		if _, err = tx.Exec(
			`INSERT INTO task_tags(task_id, ord, tag) VALUES (?, ?, ?)`,
			taskID, i, tag,
		); err != nil {
			return err
		}
	}

	err = tx.Commit()
	return err
}

// ReplaceLabels replaces all labels for one task.
func ReplaceLabels(db *sql.DB, taskID string, nodes []LabelNode) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec(`DELETE FROM task_labels WHERE task_id = ?`, taskID); err != nil {
		return err
	}
	if err = insertLabelNodes(tx, taskID, nil, nodes); err != nil {
		return err
	}

	err = tx.Commit()
	return err
}

func loadTags(db *sql.DB, taskID string) ([]string, error) {
	rows, err := db.Query(`SELECT tag FROM task_tags WHERE task_id = ? ORDER BY ord, tag`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, err
		}
		out = append(out, tag)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func loadLabelRows(db *sql.DB, taskID string) ([]labelRow, error) {
	rows, err := db.Query(`
		SELECT id, parent_id, ord, text
		FROM task_labels
		WHERE task_id = ?
		ORDER BY COALESCE(parent_id, ''), ord, id
	`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []labelRow
	for rows.Next() {
		var row labelRow
		if err := rows.Scan(&row.id, &row.parentID, &row.ord, &row.text); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func insertLabelNodes(tx *sql.Tx, taskID string, parentID *string, nodes []LabelNode) error {
	for i, node := range nodes {
		var parent any
		if parentID != nil {
			parent = *parentID
		} else {
			parent = nil
		}

		if _, err := tx.Exec(
			`INSERT INTO task_labels(id, task_id, parent_id, ord, text) VALUES (?, ?, ?, ?, ?)`,
			node.ID, taskID, parent, i, node.Text,
		); err != nil {
			return err
		}

		id := node.ID
		if err := insertLabelNodes(tx, taskID, &id, node.Children); err != nil {
			return err
		}
	}
	return nil
}

// buildLabelTree builds a nested label tree from flat rows.
func buildLabelTree(rows []labelRow) []LabelNode {
	childrenByParent := map[string][]labelRow{}
	for _, row := range rows {
		key := ""
		if row.parentID.Valid {
			key = row.parentID.String
		}
		childrenByParent[key] = append(childrenByParent[key], row)
	}
	for key := range childrenByParent {
		sort.SliceStable(childrenByParent[key], func(i, j int) bool {
			if childrenByParent[key][i].ord != childrenByParent[key][j].ord {
				return childrenByParent[key][i].ord < childrenByParent[key][j].ord
			}
			return childrenByParent[key][i].id < childrenByParent[key][j].id
		})
	}

	var build func(parent string) []LabelNode
	build = func(parent string) []LabelNode {
		rows := childrenByParent[parent]
		out := make([]LabelNode, 0, len(rows))
		for _, row := range rows {
			out = append(out, LabelNode{
				ID:       row.id,
				Text:     row.text,
				Children: build(row.id),
			})
		}
		return out
	}

	return build("")
}
