import { describe, it, expect } from "vitest";
import { shouldApplyBroadcastSeq } from "./broadcastSeq";

describe("shouldApplyBroadcastSeq", () => {
  it("递增的序号都会被应用，并记住最大值", () => {
    const applied = new Map<string, number>();
    expect(shouldApplyBroadcastSeq(applied, "w1", 100)).toBe(true);
    expect(shouldApplyBroadcastSeq(applied, "w1", 101)).toBe(true);
    expect(shouldApplyBroadcastSeq(applied, "w1", 200)).toBe(true);
    expect(applied.get("w1")).toBe(200);
  });

  it("迟到的旧消息会被丢弃", () => {
    const applied = new Map<string, number>();
    expect(shouldApplyBroadcastSeq(applied, "w1", 200)).toBe(true);
    // 乱序到达：先发的 150 后到
    expect(shouldApplyBroadcastSeq(applied, "w1", 150)).toBe(false);
    // 重复消息同样丢弃
    expect(shouldApplyBroadcastSeq(applied, "w1", 200)).toBe(false);
    expect(applied.get("w1")).toBe(200);
  });

  it("不同 widget 的序号互不影响", () => {
    const applied = new Map<string, number>();
    expect(shouldApplyBroadcastSeq(applied, "w1", 500)).toBe(true);
    expect(shouldApplyBroadcastSeq(applied, "w2", 1)).toBe(true);
    expect(applied.get("w1")).toBe(500);
    expect(applied.get("w2")).toBe(1);
  });

  it("老后端不带 seq 时保持原行为（兼容滚动升级）", () => {
    const applied = new Map<string, number>();
    expect(shouldApplyBroadcastSeq(applied, "w1", undefined)).toBe(true);
    expect(shouldApplyBroadcastSeq(applied, "w1", null)).toBe(true);
    expect(shouldApplyBroadcastSeq(applied, "w1", 0)).toBe(true);
    expect(shouldApplyBroadcastSeq(applied, "w1", "")).toBe(true);
    expect(applied.size).toBe(0);
  });

  it("widgetId 为空时不应用", () => {
    const applied = new Map<string, number>();
    expect(shouldApplyBroadcastSeq(applied, "", 10)).toBe(false);
  });

  it("非有限数值（NaN / Infinity）不参与比较但允许应用", () => {
    const applied = new Map<string, number>();
    expect(shouldApplyBroadcastSeq(applied, "w1", Number.NaN)).toBe(true);
    expect(shouldApplyBroadcastSeq(applied, "w1", Number.POSITIVE_INFINITY)).toBe(true);
    expect(applied.size).toBe(0);
  });
});
