import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearLanProbeCache,
  decideBookmarkTarget,
  isMixedContentBlocked,
  peekLanProbe,
  probeAnyReachable,
  probeLanUrl,
} from "./lanProbe";

const noop = () => {};

describe("isMixedContentBlocked", () => {
  it("HTTPS 页面探测 HTTP 内网地址会被浏览器拦截", () => {
    expect(isMixedContentBlocked("http://192.168.1.5:8080", "https:")).toBe(true);
  });

  it("HTTP 页面、或目标是 HTTPS 时不算 Mixed Content", () => {
    expect(isMixedContentBlocked("http://192.168.1.5:8080", "http:")).toBe(false);
    expect(isMixedContentBlocked("https://nas.local", "https:")).toBe(false);
  });

  it("空值不算", () => {
    expect(isMixedContentBlocked("", "https:")).toBe(false);
  });
});

describe("probeLanUrl", () => {
  beforeEach(() => clearLanProbeCache());

  it("能拿到 opaque 响应 → 判定内网可达", async () => {
    const fetchImpl = vi.fn(async () => ({ type: "opaque" })) as unknown as typeof fetch;
    const outcome = await probeLanUrl("http://192.168.1.5:8080", { fetchImpl, pageProtocol: "http:" });
    expect(outcome).toBe("reachable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect(init.mode).toBe("no-cors");
    expect(init.cache).toBe("no-store");
  });

  it("连接失败 → 判定不可达", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await probeLanUrl("http://192.168.1.5:8080", { fetchImpl, pageProtocol: "http:" })).toBe("unreachable");
  });

  it("Mixed Content 场景直接返回 blocked，且不发请求", async () => {
    const fetchImpl = vi.fn(noop) as unknown as typeof fetch;
    expect(await probeLanUrl("http://192.168.1.5:8080", { fetchImpl, pageProtocol: "https:" })).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("空值/非法协议返回 skipped", async () => {
    const fetchImpl = vi.fn(noop) as unknown as typeof fetch;
    expect(await probeLanUrl("", { fetchImpl })).toBe("skipped");
    expect(await probeLanUrl("javascript:alert(1)", { fetchImpl })).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("结果进缓存，重复探测不再发请求", async () => {
    const fetchImpl = vi.fn(async () => ({ type: "opaque" })) as unknown as typeof fetch;
    await probeLanUrl("http://192.168.1.5:8080", { fetchImpl, pageProtocol: "http:" });
    await probeLanUrl("http://192.168.1.5:8080", { fetchImpl, pageProtocol: "http:" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(peekLanProbe("http://192.168.1.5:8080")).toBe("reachable");
  });

  it("缓存过期后会重新探测", async () => {
    let now = 1000;
    const fetchImpl = vi.fn(async () => ({ type: "opaque" })) as unknown as typeof fetch;
    const deps = { fetchImpl, pageProtocol: "http:", now: () => now, ttlMs: 1000 };
    await probeLanUrl("http://192.168.1.5:8080", deps);
    now = 1500;
    expect(peekLanProbe("http://192.168.1.5:8080", { now: () => now, ttlMs: 1000 })).toBe("reachable");
    await probeLanUrl("http://192.168.1.5:8080", deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 3000; // 超过 TTL
    expect(peekLanProbe("http://192.168.1.5:8080", { now: () => now, ttlMs: 1000 })).toBeNull();
    await probeLanUrl("http://192.168.1.5:8080", deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("超时会中止请求并判为不可达", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const outcome = await probeLanUrl("http://192.168.1.5:8080", {
      fetchImpl,
      pageProtocol: "http:",
      timeoutMs: 20,
    });
    expect(outcome).toBe("unreachable");
  });
});

describe("probeAnyReachable", () => {
  beforeEach(() => clearLanProbeCache());

  it("任意一个可达即返回 reachable", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("192.168.1.9")) throw new TypeError("Failed to fetch");
      return { type: "opaque" };
    }) as unknown as typeof fetch;
    const outcome = await probeAnyReachable(["http://192.168.1.9:1", "http://192.168.1.5:8080"], {
      fetchImpl,
      pageProtocol: "http:",
    });
    expect(outcome).toBe("reachable");
  });

  it("全部不可达返回 unreachable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const outcome = await probeAnyReachable(["http://192.168.1.9:1", "http://192.168.1.5:8080"], {
      fetchImpl,
      pageProtocol: "http:",
    });
    expect(outcome).toBe("unreachable");
  });

  it("全部被 Mixed Content 拦截时返回 blocked，交给规则回退", async () => {
    const fetchImpl = vi.fn(noop) as unknown as typeof fetch;
    const outcome = await probeAnyReachable(["http://192.168.1.9:1"], { fetchImpl, pageProtocol: "https:" });
    expect(outcome).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("没有可探测地址时返回 skipped", async () => {
    expect(await probeAnyReachable([])).toBe("skipped");
    expect(await probeAnyReachable(["", "   "])).toBe("skipped");
  });

  it("重复地址会去重", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await probeAnyReachable(["http://192.168.1.5:8080", "http://192.168.1.5:8080"], {
      fetchImpl,
      pageProtocol: "http:",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("decideBookmarkTarget：内网优先，不通回退外网", () => {
  const base = {
    url: "https://nas.example.com",
    lanUrl: "http://192.168.1.5:8080",
    loggedIn: true,
    forceMode: "auto" as const,
    effectiveIsLan: false,
  };

  it("实测内网可达 → 用内网地址", () => {
    expect(decideBookmarkTarget({ ...base, probeOutcome: "reachable" })).toBe(base.lanUrl);
  });

  it("实测内网不可达 → 回退外网地址", () => {
    expect(decideBookmarkTarget({ ...base, probeOutcome: "unreachable" })).toBe(base.url);
  });

  it("实测不可达时会覆盖全局推断（全局说内网也照样回退外网）", () => {
    expect(
      decideBookmarkTarget({ ...base, effectiveIsLan: true, probeOutcome: "unreachable" }),
    ).toBe(base.url);
  });

  it("探不出结论（Mixed Content 拦截）→ 退回全局推断", () => {
    expect(decideBookmarkTarget({ ...base, probeOutcome: "blocked" })).toBe(base.url);
    expect(decideBookmarkTarget({ ...base, probeOutcome: "blocked", effectiveIsLan: true })).toBe(
      base.lanUrl,
    );
    expect(decideBookmarkTarget({ ...base, probeOutcome: "skipped", effectiveIsLan: true })).toBe(
      base.lanUrl,
    );
  });

  it("未登录 / 没配内网地址 → 只用外网地址", () => {
    expect(decideBookmarkTarget({ ...base, loggedIn: false, probeOutcome: "reachable" })).toBe(base.url);
    expect(decideBookmarkTarget({ ...base, lanUrl: "", probeOutcome: "reachable" })).toBe(base.url);
  });

  it("强制档按全局推断走，不做探测结论覆盖", () => {
    expect(
      decideBookmarkTarget({ ...base, forceMode: "wan", effectiveIsLan: false, probeOutcome: "reachable" }),
    ).toBe(base.url);
    expect(
      decideBookmarkTarget({ ...base, forceMode: "lan", effectiveIsLan: true, probeOutcome: "unreachable" }),
    ).toBe(base.lanUrl);
  });

  it("只配了内网地址时，回退结果是空串（由调用方决定不跳转/提示登录）", () => {
    expect(decideBookmarkTarget({ ...base, url: "", probeOutcome: "unreachable" })).toBe("");
  });
});
