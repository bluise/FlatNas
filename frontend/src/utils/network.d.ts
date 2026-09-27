export type NetworkTargetType = "lan" | "overlay" | "wan";

export const NETWORK_PRESET_RULES: Record<string, string[]>;

export const DEFAULT_NETWORK_RULES: string;

export function classifyNetworkTarget(
  url: unknown,
  networkRules?: string,
  internalDomains?: string,
): NetworkTargetType;

export function detectNetworkByLatency(
  measuredLatencyMs: number,
  thresholdMs?: number,
): "lan" | "wan" | "unknown";

export function isInternalNetwork(url: unknown, internalDomains?: string, networkRules?: string): boolean;

export function getNetworkConfig(appConfig?: {
  internalDomains?: string;
  networkRules?: string;
  networkPresets?: Record<string, boolean>;
  whitelistLatencyMode?: boolean;
  latencyThresholdMs?: number;
}, localForceNetworkMode?: "auto" | "lan" | "wan" | "latency"): {
  internalDomains: string;
  networkRules: string;
  forceNetworkMode: "auto" | "lan" | "wan" | "latency";
  whitelistLatencyMode: boolean;
  latencyThresholdMs: number;
};

/** 判定原因码 → 可读文案 */
export const NETWORK_REASON_TEXT: Record<string, string>;

export type LanProbeOutcome = "reachable" | "unreachable" | "blocked" | "skipped";

export function computeEffectiveNetworkMode(
  hostname: string,
  clientIp: string,
  clientIpSource: string,
  measuredLatencyMs: number,
  config?: {
    internalDomains?: string;
    networkRules?: string;
    forceNetworkMode?: "auto" | "lan" | "wan" | "latency";
    whitelistLatencyMode?: boolean;
    latencyThresholdMs?: number;
    /** 浏览器侧内网地址可达性探测结论（FlatNas 部署在公网 VPS 时的关键判据） */
    lanProbeOutcome?: LanProbeOutcome;
  },
): { isLan: boolean; reason: string; measuredLatencyMs: number };
