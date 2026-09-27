const extractHost = (input) => {
  const value = typeof input === "string" ? input.trim() : String(input ?? "").trim();
  if (!value) return "";
  if (value.startsWith("[") && value.includes("]")) {
    return value.slice(1, value.indexOf("]"));
  }
  try {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) {
      return new URL(value).hostname;
    }
    if (value.startsWith("//")) {
      return new URL(`http:${value}`).hostname;
    }
    if (value.includes("/") || value.includes("?") || value.includes("#")) {
      return new URL(`http://${value}`).hostname;
    }
  } catch {
    return value;
  }
  return value;
};

const isIpv4 = (host) => /^(\d{1,3}\.){3}\d{1,3}$/.test(host);

const isIpv4PrefixLike = (value) => /^\d{1,3}(\.\d{1,3}){0,3}\.?$/.test(String(value || "").trim());

const isPrivateIpv4 = (host) => {
  if (!isIpv4(host)) return false;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
};

const isOverlayIpv4 = (host) => {
  if (!isIpv4(host)) return false;
  // CGNAT range, often used by overlay networks (e.g. tailscale)
  return /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./.test(host);
};

const normalizeRule = (line) => String(line || "").trim();

const parseNetworkRules = (rawRules) => {
  return String(rawRules || "")
    .split("\n")
    .map((line) => normalizeRule(line))
    .filter((line) => line && !line.startsWith("#"));
};

const normalizeRuleHostLike = (value) => {
  let v = String(value || "").trim().toLowerCase();
  if (!v) return "";

  v = v.replace(/^\*\./, "");

  const parsed = extractHost(v);
  if (parsed) {
    v = parsed.toLowerCase();
  }

  v = v.replace(/^\[|\]$/g, "").replace(/^\./, "").replace(/\/$/, "");
  return v;
};

const matchDomainSuffix = (host, suffix) => {
  const normalized = normalizeRuleHostLike(suffix);
  if (!normalized) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
};

const classifyByRules = (host, rules) => {
  for (const rule of rules) {
    const v = rule.toLowerCase();

    if (v.startsWith("domain_suffix:")) {
      const suffix = v.slice("domain_suffix:".length).trim();
      if (matchDomainSuffix(host, suffix)) {
        if (suffix.includes("ts.net") || suffix.includes("zerotier")) return "overlay";
        if (suffix.includes("trycloudflare.com") || suffix.includes("ngrok.io") || suffix.includes("ngrok-free.app"))
          return "wan";
        return "lan";
      }
      continue;
    }

    if (v.startsWith("host:")) {
      const target = normalizeRuleHostLike(v.slice("host:".length).trim());
      if (target && host === target) return "lan";
      continue;
    }

    if (v.startsWith("ip:")) {
      const rawTarget = v.slice("ip:".length).trim();
      const target = rawTarget.endsWith(".") && isIpv4(rawTarget.slice(0, -1)) ? rawTarget.slice(0, -1) : rawTarget;
      if (target && host === target) return "lan";
      if (target && isIpv4(host) && !isIpv4(target) && isIpv4PrefixLike(target)) {
        const prefix = target.endsWith(".") ? target : `${target}.`;
        if (host.startsWith(prefix)) return "lan";
      }
      continue;
    }

    // Backward compatibility:
    // - ipv4 host: plain rule means ip prefix match (e.g. 192.168.)
    // - domain host: plain rule means domain suffix match (e.g. iepose.cn / *.iepose.cn / http://iepose.cn/)
    if (isIpv4(host) && host.startsWith(v)) return "lan";
    if (matchDomainSuffix(host, v)) return "lan";
  }

  return "wan";
};

export const NETWORK_PRESET_RULES = {
  tailscale: ["domain_suffix:.ts.net", "ip:100.64."],
  zerotier: ["domain_suffix:.zerotier.net"],
  frp: ["# frp 常见为自定义域名，建议补充 host/domain_suffix 规则"],
  cloudflareTunnel: ["domain_suffix:.trycloudflare.com"],
  ngrok: ["domain_suffix:.ngrok.io", "domain_suffix:.ngrok-free.app"],
};

export const DEFAULT_NETWORK_RULES = [
  "# overlay networks",
  ...NETWORK_PRESET_RULES.tailscale,
  ...NETWORK_PRESET_RULES.zerotier,
  "# tunnels (kept as WAN by default)",
  ...NETWORK_PRESET_RULES.cloudflareTunnel,
  ...NETWORK_PRESET_RULES.ngrok,
].join("\n");

const DEFAULT_LATENCY_THRESHOLD_MS = 50;

export const classifyNetworkTarget = (url, networkRules = "", internalDomains = "") => {
  const raw = typeof url === "string" ? url.trim() : String(url ?? "").trim();
  if (!raw) return "wan";

  const host = extractHost(raw).toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "wan";

  if (host === "::1" || host.includes("localhost") || /^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) {
    return "lan";
  }

  if (isPrivateIpv4(host) || host.endsWith(".local")) return "lan";
  if (isOverlayIpv4(host)) return "overlay";

  const rules = [...parseNetworkRules(networkRules), ...parseNetworkRules(internalDomains)];
  return classifyByRules(host, rules);
};

export const detectNetworkByLatency = (measuredLatencyMs, thresholdMs = DEFAULT_LATENCY_THRESHOLD_MS) => {
  if (!Number.isFinite(measuredLatencyMs) || measuredLatencyMs < 0) return "unknown";
  if (measuredLatencyMs <= thresholdMs) return "lan";
  return "wan";
};

export const isInternalNetwork = (url, internalDomains = "", networkRules = "") => {
  const type = classifyNetworkTarget(url, networkRules, internalDomains);
  return type === "lan" || type === "overlay";
};

export const buildRulesFromPresets = (presets = {}) => {
  const enabled = Object.entries(presets || {}).filter(([, v]) => !!v);
  if (enabled.length === 0) return "";
  const lines = [];
  for (const [key] of enabled) {
    if (!NETWORK_PRESET_RULES[key]) continue;
    lines.push(...NETWORK_PRESET_RULES[key]);
  }
  return Array.from(new Set(lines)).join("\n");
};

/**
 * 家庭网络「公网出口 IP」匹配。
 *
 * 为什么需要它：FlatNas 部署在公网 VPS、且以 HTTPS 访问时，
 * 浏览器无法探测内网地址（HTTPS 页面探 HTTP 会被 Mixed Content 拦死）。
 * 但「你在不在家」这件事服务端本来就知道 —— VPS 能看到你的公网出口 IP
 * （/api/ip 已经在返回 clientIp / clientIpSource）。把你家的出口 IP 记下来比对即可，
 * 全程不需要浏览器探测；而跳转 http://192.168.x.x 是顶级导航，不受 Mixed Content 限制。
 *
 * 支持精确 IP 与前缀写法（家宽动态 IP 常见）：
 *   1.2.3.4     精确匹配
 *   1.2.3.      匹配 1.2.3.x
 *   1.2.3       匹配 1.2.3.x（等价于上面）
 *   # 注释行会被忽略
 */
const parseIpRules = (rawRules) =>
  String(rawRules || "")
    .split("\n")
    .map((line) => String(line || "").trim().toLowerCase())
    .filter((line) => line && !line.startsWith("#"));

export const isHomeClientIp = (clientIp, homePublicIps = "") => {
  const ip = String(clientIp || "").trim().toLowerCase();
  if (!ip) return false;
  for (const rule of parseIpRules(homePublicIps)) {
    if (ip === rule) return true;
    if (rule.endsWith(".") ? ip.startsWith(rule) : ip.startsWith(`${rule}.`)) return true;
  }
  return false;
};

export const getNetworkConfig = (appConfig = {}, localForceNetworkMode) => {
  const homePublicIps = typeof appConfig.homePublicIps === "string" ? appConfig.homePublicIps : "";
  const mode = typeof localForceNetworkMode === "string" ? localForceNetworkMode : "";
  const forceNetworkMode = ["auto", "lan", "wan", "latency"].includes(mode) ? mode : "auto";
  const raw = appConfig.latencyThresholdMs;
  const base = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 50;
  const latencyThresholdMs = Math.min(30000, Math.max(10, base));
  return { homePublicIps, forceNetworkMode, latencyThresholdMs };
};

export const computeEffectiveNetworkMode = (
  hostname,
  clientIp,
  clientIpSource,
  measuredLatencyMs,
  {
    forceNetworkMode = "auto",
    latencyThresholdMs = 50,
    // 家庭网络公网出口 IP（每行一个，支持前缀）；命中即认为「在家」
    homePublicIps = "",
    // 浏览器侧「内网地址可达性」探测结论（见 utils/lanProbe.ts）。
    // FlatNas 部署在公网 VPS 时，服务端看不到你的内网，只有浏览器能直接去试内网地址通不通。
    // 注意：页面是 HTTPS 而内网地址是 HTTP 时会被 Mixed Content 拦掉，探测拿不到结论。
    lanProbeOutcome = "skipped",
    // 服务端判定的「客户端出口 IP 属于家庭网络」。
    // 由 /api/ip 返回：家里 24h 设备（NAS/路由器）定时打心跳，服务端记下家里的出口 IP，
    // 之后比对访问者出口 IP 即可。HTTPS 部署同样有效，且出口 IP 动态变化也能自动跟上。
    homeNetworkMatch = false,
  } = {},
) => {
  const hostnameIntrinsicLan = isInternalNetwork(hostname, "", "");
  const canTrustClientIp = clientIpSource === "header";
  const clientIsLan = canTrustClientIp && !!clientIp && isInternalNetwork(clientIp, "", "");
  const latencyBasedLan = Number.isFinite(measuredLatencyMs) && measuredLatencyMs > 0 && measuredLatencyMs <= latencyThresholdMs;

  // 强制模式优先级最高
  if (forceNetworkMode === "lan") return { isLan: true, reason: "force_lan", measuredLatencyMs };
  if (forceNetworkMode === "wan") return { isLan: false, reason: "force_wan", measuredLatencyMs };
  // 「延迟」档：只看延迟，不看域名/IP（否则这一档在界面上等于摆设）
  if (forceNetworkMode === "latency") {
    return {
      isLan: latencyBasedLan,
      reason: latencyBasedLan ? "force_latency_lan" : "force_latency_wan",
      measuredLatencyMs,
    };
  }

  // 浏览器实测内网地址可达：比任何推断都可靠
  if (lanProbeOutcome === "reachable") return { isLan: true, reason: "lan_probe_reachable", measuredLatencyMs };

  // 服务端心跳判定「在家」：不依赖浏览器探测，HTTPS 部署下最可靠的一条
  if (homeNetworkMatch) return { isLan: true, reason: "home_beacon_match", measuredLatencyMs };

  // 客户端出口 IP 命中手动登记的「家庭网络 IP」→ 在家
  if (canTrustClientIp && homePublicIps && isHomeClientIp(clientIp, homePublicIps)) {
    return { isLan: true, reason: "home_ip_match", measuredLatencyMs };
  }

  // 域名本身是内网地址
  if (hostnameIntrinsicLan) return { isLan: true, reason: "hostname_intrinsic", measuredLatencyMs };

  // 客户端IP是内网（只有 FlatNas 与你在同一内网时才可能成立）
  if (canTrustClientIp && clientIsLan) return { isLan: true, reason: "client_ip_header", measuredLatencyMs };

  // 默认外网
  return { isLan: false, reason: "default_wan", measuredLatencyMs };
};

/** reason 的可读文案，便于在设置页/调试时看清「为什么这么判」 */
export const NETWORK_REASON_TEXT = {
  force_lan: "手动强制为内网",
  force_wan: "手动强制为外网",
  force_latency_lan: "延迟低于阈值（延迟模式）",
  force_latency_wan: "延迟高于阈值（延迟模式）",
  lan_probe_reachable: "浏览器实测内网地址可达",
  home_beacon_match: "客户端出口 IP 属于家庭网络（心跳）",
  home_ip_match: "客户端出口 IP 属于家庭网络",
  hostname_intrinsic: "访问地址本身是内网地址",
  client_ip_header: "客户端 IP 属于内网",
  default_wan: "默认判定为外网",
};
