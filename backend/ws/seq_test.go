package ws

import (
	"sync"
	"testing"
)

func TestNextWidgetSeqIsStrictlyIncreasing(t *testing.T) {
	var last int64
	for i := 0; i < 2000; i++ {
		seq := NextWidgetSeq("alice", "widget-1")
		if seq <= last {
			t.Fatalf("seq 必须严格递增：i=%d seq=%d last=%d", i, seq, last)
		}
		last = seq
	}
}

func TestNextWidgetSeqIsIndependentPerWidgetAndUser(t *testing.T) {
	a1 := NextWidgetSeq("alice", "widget-1")
	a2 := NextWidgetSeq("alice", "widget-2")
	b1 := NextWidgetSeq("bob", "widget-1")

	if a2 == 0 || b1 == 0 {
		t.Fatal("不同 widget / 用户也应分配序号")
	}
	// 各自独立计数，不能互相影响（这里只验证不相等/可达，具体值取决于墙钟）
	if a1 == a2 {
		t.Fatalf("不同 widget 的序号不应相同: %d", a1)
	}
}

func TestNextWidgetSeqEmptyArgs(t *testing.T) {
	if got := NextWidgetSeq("", "widget-1"); got != 0 {
		t.Fatalf("username 为空应返回 0, got %d", got)
	}
	if got := NextWidgetSeq("alice", ""); got != 0 {
		t.Fatalf("widgetID 为空应返回 0, got %d", got)
	}
}

func TestNextWidgetSeqConcurrent(t *testing.T) {
	const workers = 16
	const perWorker = 200
	var wg sync.WaitGroup
	results := make([][]int64, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			list := make([]int64, 0, perWorker)
			for j := 0; j < perWorker; j++ {
				list = append(list, NextWidgetSeq("carol", "widget-x"))
			}
			results[index] = list
		}(i)
	}
	wg.Wait()

	seen := make(map[int64]struct{}, workers*perWorker)
	for _, list := range results {
		for _, seq := range list {
			if _, ok := seen[seq]; ok {
				t.Fatalf("并发下产生了重复序号 %d", seq)
			}
			seen[seq] = struct{}{}
		}
	}
	if len(seen) != workers*perWorker {
		t.Fatalf("期望 %d 个唯一序号，实际 %d", workers*perWorker, len(seen))
	}
}
