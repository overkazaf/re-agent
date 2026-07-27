package app

import "testing"

func TestTaskQueueEditCancelAndPop(t *testing.T) {
	queue := newTaskQueue()
	first := queue.Add("triage ./one")
	second := queue.Add("triage ./two")
	if first.ID == second.ID || queue.Len() != 2 {
		t.Fatalf("queue ids/len wrong: first=%+v second=%+v len=%d", first, second, queue.Len())
	}
	if !queue.Edit(second.ID, "triage ./two --deep") {
		t.Fatal("expected edit to succeed")
	}
	if !queue.Cancel(first.ID) {
		t.Fatal("expected cancel to succeed")
	}
	item, ok := queue.Pop()
	if !ok || item.ID != second.ID || item.Text != "triage ./two --deep" {
		t.Fatalf("wrong queued item popped: ok=%v item=%+v", ok, item)
	}
	if _, ok := queue.Pop(); ok {
		t.Fatal("queue should be empty")
	}
}

func TestTaskQueueClear(t *testing.T) {
	queue := newTaskQueue()
	queue.Add("one")
	queue.Add("two")
	if got := queue.Clear(); got != 2 {
		t.Fatalf("clear count wrong: %d", got)
	}
	if queue.Len() != 0 {
		t.Fatalf("queue not empty: %d", queue.Len())
	}
}
