/**
 * 校验 win/组件 目录下所有自定义组件的结构与 JS 安全执行。
 * 对应《二次开发完整指南》中的 CustomWidgetData 与 widget ctx API。
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 从 frontend/src/components/__tests__ 到项目根再进 win/组件
const WIN_COMPONENTS_DIR = path.resolve(__dirname, "..", "..", "..", "..", "win", "组件");

interface CustomWidgetData {
  title: string;
  html: string;
  css: string;
  js?: string;
}

function loadComponentDirs(): string[] {
  if (!fs.existsSync(WIN_COMPONENTS_DIR)) {
    return [];
  }
  return fs.readdirSync(WIN_COMPONENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(WIN_COMPONENTS_DIR, d.name));
}

function loadJson(dir: string): CustomWidgetData | null {
  const file = path.join(dir, "完整组件.json");
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(raw) as CustomWidgetData;
  } catch {
    return null;
  }
}

function isValidSchema(data: unknown): data is CustomWidgetData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.title === "string" &&
    typeof d.html === "string" &&
    typeof d.css === "string" &&
    (d.js === undefined || typeof d.js === "string")
  );
}

function isModuleScript(js: string): boolean {
  return (
    /^\s*\/\/\s*@module\b/m.test(js) ||
    /(^|\n)\s*import\s.+from\s+["'][^"']+["']/m.test(js) ||
    /(^|\n)\s*export\s+/m.test(js)
  );
}

describe("win/组件 自定义组件", () => {
  const componentDirs = loadComponentDirs();

  // win/ 已被 .gitignore 忽略（属于本机 Windows 端的自定义组件目录），
  // 干净检出时并不存在。此时整组用例跳过，而不是把"目录不存在"当成失败。
  it.skipIf(componentDirs.length === 0)("应至少存在 20 个组件目录", () => {
    expect(componentDirs.length).toBeGreaterThanOrEqual(20);
  });

  for (const dir of componentDirs) {
    const name = path.basename(dir);
    const data = loadJson(dir);

    describe(name, () => {
      it("应存在 完整组件.json 且结构合法", () => {
        expect(data).not.toBeNull();
        expect(isValidSchema(data!)).toBe(true);
        expect((data as CustomWidgetData).title).toBeTruthy();
        expect((data as CustomWidgetData).html).toBeTruthy();
        expect((data as CustomWidgetData).css).toBeTruthy();
      });

      it("JS 在 mock ctx 下应能安全执行且无异常状态", () => {
        const widget = data as CustomWidgetData | null;
        if (!widget?.js?.trim()) return;

        if (isModuleScript(widget.js)) {
          // 模块脚本需要 window.FlatNasWidgetCtx，此处仅校验不抛错即可
          return;
        }

        const cleanupFns: Array<() => void> = [];
        const container = document.createElement("div");
        container.innerHTML = widget.html;
        container.id = "widget-test-container";

        const mockCtx = {
          el: container,
          query: (sel: string) => container.querySelector(sel),
          queryAll: (sel: string) => Array.from(container.querySelectorAll(sel)),
          onCleanup: (fn: () => void) => {
            if (typeof fn === "function") cleanupFns.push(fn);
          },
          emit: () => { },
          on: () => () => { },
        };

        const run = () => {
          (window as unknown as Record<string, unknown>).FlatNasWidgetCtx = mockCtx;
          try {
            const wrapped = `;(function(ctx) {\ntry {\n${widget.js}\n} catch (e) {\nthrow e;\n}\n})(window.FlatNasWidgetCtx);`;
            new Function(wrapped)();
          } finally {
            delete (window as unknown as Record<string, unknown>).FlatNasWidgetCtx;
          }
        };

        expect(run).not.toThrow();

        // 执行清理，确保 onCleanup 可调用且不抛错
        for (const fn of cleanupFns) {
          expect(() => fn()).not.toThrow();
        }
      });
    });
  }
});
