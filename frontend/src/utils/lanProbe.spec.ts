import { describe, it, expect, beforeEach } from "vitest";
import {
  clearLanProbeCache,
  decideBookmarkTarget,
  getLocalNetworkPermission,
  isOutcomeTrustworthy,
  peekLanProbe,
  probeLanUrl,
  type LocalNetworkPermission,
} from "./lanProbe";

// 这些用例锁住的是「公网 HTTPS 页面能不能测内网地址」这件事的实测结论：
// 未授权时失败必须当成 unknown（否则会误判成「不在内网」，在外面以外也都好用，
// 但在家就会白白走外网）；授权后失败才是真不可达。

const LAN = "http://10.0.0.1:5666/";
const okFetch = () => Promise.resolve(new Response(null, { status: 200 }));
const failFetch = () => Promise.reject(new TypeError("Failed to fetch"));

const perm = (state: LocalNetworkPermission) => () => Promise.resolve(state);

describe("probeLanUrl", () => {
  beforeEach(() => clearLanProbeCache());

  it("探测成功 → reachable（Mixed Content 只警告不拦，这条路是通的）", async () => {
    const outcome = await probeLanUrl(LAN, { fetchImpl: okFetch, queryPermission: perm("prompt") });
    expect(outcome).toBe("reachable");
    expect(peekLanProbe(LAN)).toBe("reachable");
  });

  it("权限已授予 + 探测失败 → unreachable（可以放心走外网）", async () => {
    const outcome = await probeLanUrl(LAN, { fetchImpl: failFetch, queryPermission: perm("granted") });
    expect(outcome).toBe("unreachable");
    expect(peekLanProbe(LAN)).toBe("unreachable");
  });

  it("权限未授予（prompt/denied）+ 探测失败 → unknown（绝不能当成不在内网）", async () => {
    expect(await probeLanUrl(LAN, { fetchImpl: failFetch, queryPermission: perm("prompt") })).toBe("unknown");
    clearLanProbeCache();
    expect(await probeLanUrl(LAN, { fetchImpl: failFetch, queryPermission: perm("denied") })).toBe("unknown");
    // unknown 不写缓存，避免把「测不出来」当成结论缓存住
    expect(peekLanProbe(LAN)).toBe(null);
  });

  it("浏览器没有这道权限门（旧版 Chrome / Firefox / Safari）→ 失败即真不可达", async () => {
    const outcome = await probeLanUrl(LAN, { fetchImpl: failFetch, queryPermission: perm("unsupported") });
    expect(outcome).toBe("unreachable");
  });

  it("结果会缓存，短时间内重复探测不再发请求", async () => {
    let calls = 0;
    const counting = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    await probeLanUrl(LAN, { fetchImpl: counting, queryPermission: perm("granted") });
    await probeLanUrl(LAN, { fetchImpl: counting, queryPermission: perm("granted") });
    expect(calls).toBe(1);
  });

  it("force 可以绕过缓存重新探测", async () => {
    let calls = 0;
    const counting = () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    await probeLanUrl(LAN, { fetchImpl: counting, queryPermission: perm("granted") });
    await probeLanUrl(LAN, { fetchImpl: counting, queryPermission: perm("granted"), force: true });
    expect(calls).toBe(2);
  });

  it("非 http(s) 地址不探测", async () => {
    expect(await probeLanUrl("file:///x", { fetchImpl: okFetch })).toBe("unknown");
    expect(await probeLanUrl("", { fetchImpl: okFetch })).toBe("unknown");
  });
});

describe("getLocalNetworkPermission", () => {
  it("透传浏览器返回的状态", async () => {
    expect(await getLocalNetworkPermission(perm("granted"))).toBe("granted");
    expect(await getLocalNetworkPermission(perm("prompt"))).toBe("prompt");
  });

  it("query 抛错（浏览器不认识该权限名）→ unsupported", async () => {
    expect(await getLocalNetworkPermission(() => Promise.reject(new Error("unknown permission")))).toBe(
      "unsupported",
    );
  });
});

describe("isOutcomeTrustworthy", () => {
  it("只有 granted / unsupported 时，探测失败才可信", () => {
    expect(isOutcomeTrustworthy("granted")).toBe(true);
    expect(isOutcomeTrustworthy("unsupported")).toBe(true);
    expect(isOutcomeTrustworthy("prompt")).toBe(false);
    expect(isOutcomeTrustworthy("denied")).toBe(false);
  });
});

describe("decideBookmarkTarget", () => {
  const lan = "http://10.0.0.1:5666/";
  const wan = "https://nas.example.com/";

  it("实测可达 → 内网地址", () => {
    expect(decideBookmarkTarget(lan, wan, "reachable")).toBe(lan);
  });

  it("实测不可达（已授权）→ 外网地址", () => {
    expect(decideBookmarkTarget(lan, wan, "unreachable")).toBe(wan);
  });

  it("测不出来 → 内网优先（界面会给一键切外网的退路）", () => {
    expect(decideBookmarkTarget(lan, wan, "unknown")).toBe(lan);
  });

  it("没配内网地址 → 外网地址；只有内网地址 → 内网地址", () => {
    expect(decideBookmarkTarget("", wan, "reachable")).toBe(wan);
    expect(decideBookmarkTarget(lan, "", "unreachable")).toBe(lan);
  });
});
