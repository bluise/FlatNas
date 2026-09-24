/**
 * 版本号比较。
 *
 * 更新检查原先的判定是 `currentVersion !== latestVersion`——只要不相等就提示有更新，
 * 于是本地版本比远端新时（例如自己构建的版本）也会一直弹提示。
 * 这里只关心"远端是不是真的更新"。
 */

/** 把 v1.6.1 / 1.6.1-beta.2 之类的字符串拆成数字段，非数字段按 0 处理 */
export function parseVersionParts(raw: string): number[] {
  return String(raw ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.\-+_]/)
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** remote 是否比 current 更新（纯数字段逐位比较） */
export function isRemoteVersionNewer(remote: string, current: string): boolean {
  if (!remote) return false;
  if (!current) return true;
  const r = parseVersionParts(remote);
  const c = parseVersionParts(current);
  const len = Math.max(r.length, c.length);
  for (let i = 0; i < len; i++) {
    const rv = r[i] ?? 0;
    const cv = c[i] ?? 0;
    if (rv !== cv) return rv > cv;
  }
  return false;
}
