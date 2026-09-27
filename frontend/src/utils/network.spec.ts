import { describe, it, expect } from "vitest";
import {
  classifyNetworkTarget,
  computeEffectiveNetworkMode,
  getNetworkConfig,
  isInternalNetwork,
} from "./network";

describe("network rules: ip:", () => {
  it("matches ip prefix with trailing dot", () => {
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22.", "")).toBe("lan");
    expect(isInternalNetwork("11.22.33.44", "", "ip:11.22.")).toBe(true);
  });

  it("matches ip prefix without trailing dot", () => {
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22", "")).toBe("lan");
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22.33", "")).toBe("lan");
  });

  it("matches full ipv4 exactly (does not behave like prefix)", () => {
    expect(classifyNetworkTarget("11.22.33.44", "ip:11.22.33.44", "")).toBe("lan");
    expect(classifyNetworkTarget("11.22.33.45", "ip:11.22.33.44", "")).toBe("wan");
  });

  it("does not match domains", () => {
    expect(classifyNetworkTarget("example.com", "ip:11.22.", "")).toBe("wan");
  });
});


describe("getNetworkConfig", () => {
  it("保留 latency 强制档（此前会被静默降级成 auto）", () => {
    expect(getNetworkConfig({}, "latency").forceNetworkMode).toBe("latency");
    expect(getNetworkConfig({}, "lan").forceNetworkMode).toBe("lan");
    expect(getNetworkConfig({}, "啥也不是").forceNetworkMode).toBe("auto");
  });

  it("把白名单延迟开关带出来（此前各调用点都漏传）", () => {
    expect(getNetworkConfig({ whitelistLatencyMode: true }).whitelistLatencyMode).toBe(true);
    expect(getNetworkConfig({}).whitelistLatencyMode).toBe(false);
  });

  it("延迟阈值夹在 10~30000ms", () => {
    expect(getNetworkConfig({ latencyThresholdMs: 5 }).latencyThresholdMs).toBe(10);
    expect(getNetworkConfig({ latencyThresholdMs: 99999 }).latencyThresholdMs).toBe(30000);
  });
});

describe("computeEffectiveNetworkMode", () => {
  // 公网 VPS 部署：用公网域名访问，服务端看到的也是客户端公网出口 IP
  const vps = { hostname: "flatnas.example.com", clientIp: "203.0.113.9", clientIpSource: "header" };

  it("公网 VPS + 无任何线索 → 判定外网（这就是原本永远命不中的原因）", () => {
    const r = computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 30, {});
    expect(r.isLan).toBe(false);
    expect(r.reason).toBe("default_wan");
  });

  it("浏览器实测内网地址可达 → 判定内网（VPS 部署的正确判据）", () => {
    const r = computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 30, {
      lanProbeOutcome: "reachable",
    });
    expect(r.isLan).toBe(true);
    expect(r.reason).toBe("lan_probe_reachable");
  });

  it("探测被 Mixed Content 拦截/不可达时不影响其他判据", () => {
    for (const outcome of ["blocked", "unreachable", "skipped"] as const) {
      const r = computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 30, {
        lanProbeOutcome: outcome,
      });
      expect(r.isLan).toBe(false);
    }
  });

  it("强制内网/外网优先级最高", () => {
    expect(
      computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 500, {
        forceNetworkMode: "lan",
      }).isLan,
    ).toBe(true);
    expect(
      computeEffectiveNetworkMode("192.168.1.5", "", "", 1, { forceNetworkMode: "wan" }).isLan,
    ).toBe(false);
  });

  it("延迟档只看延迟", () => {
    const low = computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 20, {
      forceNetworkMode: "latency",
      latencyThresholdMs: 50,
    });
    expect(low.isLan).toBe(true);
    expect(low.reason).toBe("force_latency_lan");

    const high = computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 120, {
      forceNetworkMode: "latency",
      latencyThresholdMs: 50,
    });
    expect(high.isLan).toBe(false);
    expect(high.reason).toBe("force_latency_wan");
  });

  it("白名单 + 延迟检测：延迟高就不算内网（修复前该开关传不进来，会一直算内网）", () => {
    const cfg = { internalDomains: "example.com", whitelistLatencyMode: true, latencyThresholdMs: 50 };
    expect(
      computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 20, cfg).reason,
    ).toBe("whitelist_latency_ok");
    expect(
      computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 200, cfg).reason,
    ).toBe("whitelist_latency_high");
    expect(
      computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 200, cfg).isLan,
    ).toBe(false);
  });

  it("白名单但未启用延迟检测：命中即算内网", () => {
    const r = computeEffectiveNetworkMode(vps.hostname, vps.clientIp, vps.clientIpSource, 200, {
      internalDomains: "example.com",
      whitelistLatencyMode: false,
    });
    expect(r.isLan).toBe(true);
    expect(r.reason).toBe("whitelist_matched");
  });

  it("内网部署场景（用私网地址访问）仍然照常命中", () => {
    const r = computeEffectiveNetworkMode("192.168.1.10", "", "", 5, {});
    expect(r.isLan).toBe(true);
    expect(r.reason).toBe("hostname_intrinsic");
  });

  it("客户端 IP 是私网且来源可信时算内网", () => {
    const r = computeEffectiveNetworkMode("nas.example.com", "192.168.1.20", "header", 60, {});
    expect(r.isLan).toBe(true);
    expect(r.reason).toBe("client_ip_header");
    // 来源不可信（例如 CDN 伪造头）时不采信
    expect(
      computeEffectiveNetworkMode("nas.example.com", "192.168.1.20", "remote", 60, {}).isLan,
    ).toBe(false);
  });
});
