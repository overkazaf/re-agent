package app

import (
	"fmt"
	"strings"
	"sync"
)

type queuedTask struct {
	ID   int
	Text string
}

type taskQueue struct {
	mu     sync.Mutex
	nextID int
	items  []queuedTask
}

func newTaskQueue() *taskQueue {
	return &taskQueue{nextID: 1}
}

func (q *taskQueue) Add(text string) queuedTask {
	q.mu.Lock()
	defer q.mu.Unlock()
	item := queuedTask{ID: q.nextID, Text: strings.TrimSpace(text)}
	q.nextID++
	q.items = append(q.items, item)
	return item
}

func (q *taskQueue) Pop() (queuedTask, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return queuedTask{}, false
	}
	item := q.items[0]
	copy(q.items, q.items[1:])
	q.items = q.items[:len(q.items)-1]
	return item, true
}

func (q *taskQueue) Edit(id int, text string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for index := range q.items {
		if q.items[index].ID == id {
			q.items[index].Text = strings.TrimSpace(text)
			return true
		}
	}
	return false
}

func (q *taskQueue) Cancel(id int) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for index := range q.items {
		if q.items[index].ID == id {
			q.items = append(q.items[:index], q.items[index+1:]...)
			return true
		}
	}
	return false
}

func (q *taskQueue) Clear() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	count := len(q.items)
	q.items = nil
	return count
}

func (q *taskQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func (q *taskQueue) List() []queuedTask {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make([]queuedTask, len(q.items))
	copy(out, q.items)
	return out
}

func formatQueue(items []queuedTask) string {
	if len(items) == 0 {
		return "queue empty"
	}
	lines := make([]string, 0, len(items)+1)
	lines = append(lines, "queued tasks:")
	for _, item := range items {
		lines = append(lines, fmt.Sprintf("  #%d %s", item.ID, item.Text))
	}
	return strings.Join(lines, "\n")
}
