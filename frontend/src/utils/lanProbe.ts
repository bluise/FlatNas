/**
 * 内网地址可达性探测 —— FlatNas 在公网 VPS 上判断「现在能不能走内网」的唯一可靠手段。
 *
 * # 为什么这条路是通的（以下都是实测数据，不是推测）
 *
 * 用真实 Chromium 在「公网 HTTPS 页面」里对 `http://<私网 IP>:端口` 发起
 * `fetch(url, { mode: "no-cors" })`：
 *
 * | 场景 | 结果 |
 * |---|---|
 * | 未授予「本地网络访问」权限 | ❌ `TypeError: Failed to fetch`（4~8ms） |
 * | 已授予该权限、地址可达 | ✅ 返回 opaque 响应（`status 0`, `type "opaque"`） |
 * | 已授予该权限、地址不可达 | ❌ `TypeError: Failed to fetch`（3~6ms） |
 *
 * 两个容易踩的误解：
 *
 * 1. **Mixed Content 并不会拦住它** —— Chrome 只打一条 warning
 *    （"This content should also be served over HTTPS."），请求照发。
 *    历史上 FlatNas 里写过一句「页面是 HTTPS + 目标是 HTTP → 直接放弃」，
 *    于是探测从来没真正执行过，内网判定自然永远是空的。
 *
 * 2. 真正拦截的是 **Private Network Access / Local Network Access**：
 *    公网来源访问私网地址需要授权。控制台会写
 *    `... has been blocked by CORS policy: Permission was denied for this request to access the local network`。
 *    这个权限**可以授予**（`navigator.permissions.query({name:"local-network-access"})` 返回
 *    `prompt`，用户允许后变成 `granted`）。授予后探测结果就完全可信。
 *
 * # 因此这里的策略
 *
 * - 探测「成功」→ 一定是可达（内网地址可用）。
 * - 探测「失败」→ 只有在**能确认权限已授予**（或该浏览器没有这道权限门）时才判定为不可达；
 *   否则返回 `unknown`，交给上层用「内网优先 + 一键切外网」兜底，绝不误判成外网。
 */

export type LanProbeOutcome = "reachable" | "unreachable" | "unknown";

/** 浏览器「本地网络访问」权限状态 */
export type LocalNetworkPermission = "granted" | "denied" | "prompt" | "unsupported";

export const DEFAULT_PROBE_TIMEOUT_MS = 1200;
export const DEFAULT_PROBE_TTL_MS = 60_000;

type ProbeDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  queryPermission?: () => Promise<LocalNetworkPermission>;
};

const cache = new Map<string, { at: number; outcome: LanProbeOutcome }>();

// 探测成功等价于「权限已授予」，记下来供设置页/横幅显示，省掉一次 query
let cachedPermission: LocalNetworkPermission | null = null;
export function setCachedPermission(state: LocalNetworkPermission): void {
  cachedPermission = state;
}
export function getCachedPermission(): LocalNetworkPermission | null {
  return cachedPermission;
}

/** 只探测 http(s)，其它协议（file:、javascript: 等）直接跳过 */
export function isProbeableUrl(targetUrl: string): boolean {
  const raw = String(targetUrl || "").trim();
  if (!raw) return false;
  return /^https?:\/\//i.test(raw) || raw.startsWith("//");
}

function absoluteUrl(targetUrl: string): string {
  const raw = String(targetUrl || "").trim();
  if (raw.startsWith("//") && typeof location !== "undefined") {
    return `${location.protocol}${raw}`;
  }
  return raw;
}

/**
 * 查询浏览器的「本地网络访问」权限。
 *
 * - `unsupported`：浏览器不认识这个权限名（旧版 Chrome / Firefox / Safari）。
 *   这些浏览器里没有这道权限门，探测失败就是真不可达。
 */
export async function getLocalNetworkPermission(
  queryPermission?: () => Promise<LocalNetworkPermission>,
): Promise<LocalNetworkPermission> {
  if (queryPermission) {
    try {
      return await queryPermission();
    } catch {
      return "unsupported";
    }
  }
  try {
    const permissions = (typeof navigator !== "undefined" ? navigator : undefined)?.permissions;
    if (!permissions?.query) return "unsupported";
    const status = await permissions.query({
      name: "local-network-access" as PermissionName,
    });
    const state = status?.state;
    if (state === "granted" || state === "denied" || state === "prompt") return state;
    return "unsupported";
  } catch {
    return "unsupported";
  }
}

/**
 * 探测结论是否可信。
 *
 * 权限已授予、或浏览器没有这道门 → 失败即真不可达。
 * 处于 `prompt` / `denied` → 失败也可能只是被权限挡住，不能当成「不在内网」。
 */
export function isOutcomeTrustworthy(permission: LocalNetworkPermission): boolean {
  return permission === "granted" || permission === "unsupported";
}

/** 读缓存（不触发探测） */
export function peekLanProbe(
  targetUrl: string,
  { now = Date.now, ttlMs = DEFAULT_PROBE_TTL_MS }: ProbeDeps = {},
): LanProbeOutcome | null {
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
 * 探测一个地址是否可达。
 *
 * 结果是 `reachable` / `unreachable` / `unknown`，只有前两者可信；
 * `unknown` 表示「测不出来」（多半是权限没给），上层应按「内网优先」处理。
 *
 * 结果会缓存（默认 60 秒），因此重复点击几乎无成本。
 */
export async function probeLanUrl(
  targetUrl: string,
  deps: ProbeDeps & { force?: boolean } = {},
): Promise<LanProbeOutcome> {
  const {
    fetchImpl = typeof fetch !== "undefined" ? fetch : undefined,
    now = Date.now,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    ttlMs = DEFAULT_PROBE_TTL_MS,
    queryPermission,
    force = false,
  } = deps;

  const raw = String(targetUrl || "").trim();
  if (!isProbeableUrl(raw)) return "unknown";

  const url = absoluteUrl(raw);
  if (!force) {
    const cached = peekLanProbe(url, { now, ttlMs });
    if (cached) return cached;
  }
  if (!fetchImpl) return "unknown";

  // 先看权限：未授予时，探测失败不能解读成「不在内网」
  const permission = await getLocalNetworkPermission(queryPermission);

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
    setCachedPermission("granted");
  } catch {
    outcome = isOutcomeTrustworthy(permission) ? "unreachable" : "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (outcome !== "unknown") {
    cache.set(url, { at: now(), outcome });
  }
  return outcome;
}

/**
 * 由探测结论决定这次走哪个地址。
 *
 * | 探测结论 | 结果 |
 * |---|---|
 * | `reachable` | 用内网地址 |
 * | `unreachable`（权限已授权，确认不可达） | 用外网地址 |
 * | `unknown`（多半是权限没给） | 用内网地址，并由界面给出「改用外网」的退路 |
 */
export function decideBookmarkTarget(
  lanUrl: string,
  wanUrl: string,
  outcome: LanProbeOutcome,
): string {
  const lan = String(lanUrl || "").trim();
  const wan = String(wanUrl || "").trim();
  if (!lan) return wan;
  if (outcome === "reachable") return lan;
  if (outcome === "unreachable") return wan || lan;
  return lan;
}
