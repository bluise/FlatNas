package ws

import (
	"sync"
	"time"
)

// widgetSeq 为每个 (用户, widget) 维护单调递增的广播序号。
//
// 背景：BroadcastToUser 会为每个接收者单独起一个 goroutine 写连接（见 manager.go），
// 因此同一 widget 的连续两条广播完全可能后发先至。客户端一旦无条件应用
// `w.data = payload.content`，迟到的旧消息就会把新状态覆盖回去
// —— 表现为"刚改/刚删的内容又变回去了"。
//
// 客户端按 widget 记住已应用的最大 seq，丢弃 seq 更小的消息即可。
// 这里用"墙钟毫秒，且保证严格递增"：服务重启后序号不会倒退，
// 同一毫秒内的多次广播也不会产生相同序号。
var (
	widgetSeqMu sync.Mutex
	widgetSeq   = map[string]int64{}
)

// NextWidgetSeq 返回该 (用户, widget) 的下一个广播序号。
func NextWidgetSeq(username, widgetID string) int64 {
	if username == "" || widgetID == "" {
		return 0
	}
	key := username + "|" + widgetID
	widgetSeqMu.Lock()
	defer widgetSeqMu.Unlock()
	next := time.Now().UnixMilli()
	if next <= widgetSeq[key] {
		next = widgetSeq[key] + 1
	}
	widgetSeq[key] = next
	return next
}
