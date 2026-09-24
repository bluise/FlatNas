import { describe, it, expect } from "vitest";
import { isRemoteVersionNewer, parseVersionParts } from "./version";

describe("parseVersionParts", () => {
  it("去掉 v 前缀并按 . - + _ 拆分", () => {
    expect(parseVersionParts("v1.6.1")).toEqual([1, 6, 1]);
    expect(parseVersionParts("1.6.1")).toEqual([1, 6, 1]);
    expect(parseVersionParts("1.6.1-beta.2")).toEqual([1, 6, 1, 0, 2]);
    expect(parseVersionParts("  V2.0  ")).toEqual([2, 0]);
  });

  it("非数字段按 0 处理，不抛错", () => {
    expect(parseVersionParts("abc")).toEqual([0]);
    expect(parseVersionParts("")).toEqual([0]);
  });
});

describe("isRemoteVersionNewer", () => {
  it("远端更高时为 true", () => {
    expect(isRemoteVersionNewer("1.6.2", "1.6.1")).toBe(true);
    expect(isRemoteVersionNewer("1.7.0", "1.6.9")).toBe(true);
    expect(isRemoteVersionNewer("2.0", "1.9.9")).toBe(true);
    expect(isRemoteVersionNewer("v1.6.10", "1.6.9")).toBe(true);
  });

  it("远端更低或相同时为 false（这是修复的关键：本地更新不该提示）", () => {
    expect(isRemoteVersionNewer("1.2.6", "1.6.1")).toBe(false);
    expect(isRemoteVersionNewer("1.6.1", "1.6.1")).toBe(false);
    expect(isRemoteVersionNewer("v1.6.1", "1.6.1")).toBe(false);
    expect(isRemoteVersionNewer("1.6", "1.6.0")).toBe(false);
  });

  it("远端为空时不提示；本地为空时视为需要更新", () => {
    expect(isRemoteVersionNewer("", "1.6.1")).toBe(false);
    expect(isRemoteVersionNewer("1.6.1", "")).toBe(true);
  });
});
