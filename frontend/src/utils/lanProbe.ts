/**
 * 浏览器侧「内网地址可达性」探测。
 *
 * 为什么需要它：原来的内网判定回答的是「**客户端是否与 FlatNas 服务器处于同一内网**」——
 * 用访问 FlatNas 的域名是不是私网、以及服务端看到的客户端 IP 是不是私网来判断。
 * 这套逻辑只在 FlatNas 部署在同一局域网内（例如装在 NAS 上、你用 192.168.x.x 访问）时成立。
 *
 * FlatNas 部署在公网 VPS 时，两个条件在结构上永远不成立：
 *   - 你用的是公网域名/VPS IP 访问 → hostname 不是私网；
 *   - 服务端看到的是你**家庭出口的公网 IP** → 也不是私网。
 * 所以「内网判定」永远命中不了。
 *
 * 真正该问的问题是：**浏览器能不能直接访问这个书签配置的内网地址**。
 * 只有浏览器知道答案，所以这里用一次极短的探测来回答：
 *   - `fetch(url, { mode: 'no-cors' })` 拿到 opaque 响应 → 网络层可达（DNS/TCP/HTTP 都通）→ 用内网地址
 *   - 抛错（连接被拒 / DNS 失败 / 超时）→ 不可达 → 用外网地址
 * 局域网 RTT 通常 < 5ms，350ms 超时足够，且结果会缓存，点击时基本不需要等待。
 *
 * 已知限制：页面是 HTTPS、目标内网地址是 HTTP 时，浏览器会按 Mixed Content 直接拦截，
 * 探测拿不到有效结论（返回 `blocked`），此时应回退到规则/手动模式。
 */

export type LanProbeOutcome = "reachable" | "unreachable" | "blocked" | "skipped";

export const DEFAULT_PROBE_TIMEOUT_MS = 350;
export const DEFAULT_PROBE_TTL_MS = 60_000;

type ProbeDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  pageProtocol?: string;
};

const cache = new Map<string, { at: number; outcome: LanProbeOutcome }>();

/** 页面 HTTPS + 目标是 HTTP 时，浏览器必然拦截，探也没用 */
export function isMixedContentBlocked(
  targetUrl: string,
  pageProtocol = typeof location !== "undefined" ? location.protocol : "http:",
): boolean {
  const raw = String(targetUrl || "").trim().toLowerCase();
  if (!raw) return false;
  return pageProtocol === "https:" && raw.startsWith("http://");
}

function looksLikeUsableUrl(targetUrl: string): boolean {
  const raw = String(targetUrl || "").trim();
  if (!raw) return false;
  // 只探测 http(s)，避免 file: / javascript: 之类
  return /^https?:\/\//i.test(raw) || raw.startsWith("//");
}

function absoluteUrl(targetUrl: string): string {
  const raw = String(targetUrl || "").trim();
  if (raw.startsWith("//") && typeof location !== "undefined") {
    return `${location.protocol}${raw}`;
  }
  return raw;
}

/** 读缓存（不触发探测） */
export function peekLanProbe(targetUrl: string, { now = Date.now, ttlMs = DEFAULT_PROBE_TTL_MS }: ProbeDeps = {}): LanProbeOutcome | null {
  const key = absoluteUrl(targetUrl);
  const hit = cache.get(key);
  if (!hit) return null;
  if (now() - hit.at > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.outcome;
}

export function clearLanProbeCache(): void {
  cache.clear();
}

/**
 * 探测一个内网地址是否可达。结果会写入缓存，因此重复调用几乎无成本。
 */
export async function probeLanUrl(targetUrl: string, deps: ProbeDeps = {}): Promise<LanProbeOutcome> {
  const {
    fetchImpl = typeof fetch !== "undefined" ? fetch : undefined,
    now = Date.now,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    ttlMs = DEFAULT_PROBE_TTL_MS,
    pageProtocol,
  } = deps;

  const raw = String(targetUrl || "").trim();
  if (!looksLikeUsableUrl(raw)) return "skipped";

  const url = absoluteUrl(raw);

  const cached = peekLanProbe(url, { now, ttlMs });
  if (cached) return cached;

  if (isMixedContentBlocked(url, pageProtocol)) {
    // 不写缓存：页面协议变了（比如换用 http 访问）结论就不同了
    return "blocked";
  }
  if (!fetchImpl) return "skipped";

  let outcome: LanProbeOutcome;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    await fetchImpl(url, {
      mode: "no-cors",
      cache: "no-store",
      redirect: "follow",
      signal: controller ? controller.signal : undefined,
    });
    // no-cors 下只能拿到 opaque 响应，但能拿到就说明网络层通了
    outcome = "reachable";
  } catch {
    outcome = "unreachable";
  } finally {
    if (timer) clearTimeout(timer);
  }

  cache.set(url, { at: now(), outcome });
  return outcome;
}

/**
 * 批量探测（带去重与并发上限），返回「是否存在可达的内网地址」。
 * 用于在页面加载后预热缓存，并给全局「当前是否处于内网」提供依据。
 */
export async function probeAnyReachable(
  urls: string[],
  { concurrency = 4, ...deps }: ProbeDeps & { concurrency?: number } = {},
): Promise<LanProbeOutcome> {
  const candidates = Array.from(
    new Set(
      (urls || [])
        .map((u) => String(u || "").trim())
        .filter((u) => looksLikeUsableUrl(u))
        .map((u) => absoluteUrl(u)),
    ),
  );
  if (candidates.length === 0) return "skipped";

  let blockedCount = 0;
  let cursor = 0;

  const worker = async (): Promise<LanProbeOutcome> => {
    while (cursor < candidates.length) {
      const url = candidates[cursor++];
      const outcome = await probeLanUrl(url, deps);
      if (outcome === "reachable") return "reachable";
      if (outcome === "blocked") blockedCount += 1;
    }
    return "unreachable";
  };

  const results = await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );
  if (results.includes("reachable")) return "reachable";
  // 全部被 Mixed Content 拦住时，交给上层回退到规则/手动
  return blockedCount > 0 && blockedCount === candidates.length ? "blocked" : "unreachable";
}
