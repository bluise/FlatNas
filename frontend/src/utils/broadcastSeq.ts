/**
 * WebSocket 广播的乱序防护。
 *
 * 后端 BroadcastToUser 会为每个接收者单独起 goroutine 写连接（ws/manager.go），
 * 同一 widget 的连续两条广播完全可能后发先至。若客户端无条件应用
 * `w.data = payload.content`，迟到的旧消息就会覆盖更新的状态
 * —— 表现为"刚改/刚删的内容又变回去了"。
 *
 * 服务端为每个 (用户, widget) 分配严格递增的 seq，客户端只需记住每个 widget
 * 已应用的最大 seq，丢弃更小的即可。
 */
export function shouldApplyBroadcastSeq(
  appliedSeqs: Map<string, number>,
  widgetId: string,
  seq: unknown,
): boolean {
  if (!widgetId) return false;
  // 老版本后端不带 seq：保持原有行为（兼容滚动升级）
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) return true;

  const applied = appliedSeqs.get(widgetId) ?? 0;
  if (seq <= applied) return false;

  appliedSeqs.set(widgetId, seq);
  return true;
}
