// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

// 用一个内存实现替代 idb，方便验证持久化 hook 本身的行为
const { fakeDB } = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const memos = new Map<string, Row>();
  const versions: Row[] = [];
  const fakeDB = {
    memos,
    versions,
    reset() {
      memos.clear();
      versions.length = 0;
    },
    async put(store: string, value: Row) {
      if (store === "memos") memos.set(String(value.id), value);
      else {
        const index = versions.findIndex((item) => item.id === value.id);
        if (index >= 0) versions[index] = value;
        else versions.push(value);
      }
      return value.id;
    },
    async get(store: string, key: string) {
      return store === "memos" ? memos.get(String(key)) : versions.find((v) => v.id === key);
    },
    async getAllFromIndex(_store: string, _index: string, widgetId: unknown) {
      return versions.filter((v) => v.widgetId === widgetId);
    },
    async delete(_store: string, key: string) {
      const index = versions.findIndex((v) => v.id === key);
      if (index >= 0) versions.splice(index, 1);
    },
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
  };
  return { fakeDB };
});

vi.mock("idb", () => ({
  openDB: vi.fn(async () => fakeDB),
}));

import { useMemoPersistence } from "../Memo/useMemoPersistence";

describe("useMemoPersistence", () => {
  beforeEach(() => {
    fakeDB.reset();
    localStorage.clear();
  });

  it("loadFromIndexedDB 只读取，不擅自改写 localData / mode", async () => {
    const localData = ref("内存里的当前内容");
    const mode = ref<"simple" | "rich">("rich");
    const serverTs = ref(0);
    const api = useMemoPersistence("w1", localData, mode, serverTs);

    await api.saveToIndexedDB({ pending: false });
    localData.value = "内存里被改成别的内容";
    mode.value = "simple";

    const record = await api.loadFromIndexedDB();

    expect(record?.content).toBe("内存里的当前内容");
    // 关键：读取缓存不能反过来覆盖调用方的状态
    expect(localData.value).toBe("内存里被改成别的内容");
    expect(mode.value).toBe("simple");
  });

  it("保存的记录带上 pending 与 serverTs 标记", async () => {
    const localData = ref("内容");
    const mode = ref<"simple" | "rich">("simple");
    const serverTs = ref(1234);
    const api = useMemoPersistence("w1", localData, mode, serverTs);

    await api.saveToIndexedDB({ pending: true });
    expect(await api.loadFromIndexedDB()).toMatchObject({
      content: "内容",
      pending: true,
      serverTs: 1234,
    });

    await api.saveToIndexedDB({ pending: false });
    expect(await api.loadFromIndexedDB()).toMatchObject({ pending: false });
  });

  it("版本历史会裁剪到上限，避免无限增长", async () => {
    const localData = ref("v0");
    const mode = ref<"simple" | "rich">("simple");
    const serverTs = ref(0);
    const api = useMemoPersistence("w1", localData, mode, serverTs);

    for (let i = 0; i < 45; i++) {
      localData.value = `v${i}`;
      await api.saveVersionSnapshot(true);
    }

    const versions = await api.loadVersions();
    expect(versions.length).toBeLessThanOrEqual(30);
    expect(versions.length).toBeGreaterThan(0);
    // 保留的应该是最新的那一批
    expect(versions[0].content).toBe("v44");
  });

  it("版本历史只影响当前 widget", async () => {
    const localDataA = ref("a");
    const mode = ref<"simple" | "rich">("simple");
    const apiA = useMemoPersistence("wA", localDataA, mode, ref(0));
    const localDataB = ref("b");
    const apiB = useMemoPersistence("wB", localDataB, mode, ref(0));

    await apiA.saveVersionSnapshot(true);
    await apiB.saveVersionSnapshot(true);

    expect((await apiA.loadVersions()).length).toBe(1);
    expect((await apiB.loadVersions()).length).toBe(1);
  });
});
