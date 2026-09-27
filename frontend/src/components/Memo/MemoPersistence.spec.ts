// @vitest-environment jsdom
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import MemoWidget from "../MemoWidget.vue";
import type { WidgetConfig } from "@/types";

const { mockPut, mockGet, fetchMock, wsSendMock } = vi.hoisted(() => ({
  mockPut: vi.fn(),
  mockGet: vi.fn(),
  fetchMock: vi.fn(),
  wsSendMock: vi.fn(),
}));

vi.mock("idb", () => ({
  openDB: vi.fn().mockResolvedValue({
    put: mockPut,
    get: mockGet,
    getAllFromIndex: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
    createObjectStore: vi.fn(),
  }),
}));

vi.mock("../../stores/main", () => ({
  useMainStore: () => ({
    isLogged: true,
    isLanModeInited: true,
    effectiveIsLan: false,
    isConnected: false,
    token: "test-token",
    getHeaders: () => ({ Authorization: "Bearer test-token" }),
    wsSend: wsSendMock,
    saveSingleWidget: vi.fn(),
  }),
}));

vi.stubGlobal("fetch", fetchMock);

// 与 useMemoPersistence 内一致的 DJB2 校验和
const checksumOf = (str: string) => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
});

const idbRecord = (content: string, extra: Record<string, unknown> = {}) => ({
  id: "memo-1",
  content,
  mode: "simple" as const,
  updatedAt: Date.now(),
  checksum: checksumOf(content),
  ...extra,
});

const makeWidget = (data: unknown): { widget: WidgetConfig } =>
  ({
    widget: {
      id: "memo-1",
      type: "memo",
      data,
      enable: true,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    },
  }) as unknown as { widget: WidgetConfig };

const flush = async (ms = 0) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await nextTick();
};

const putCalls = () =>
  fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
  );

const putBodies = () =>
  putCalls().map((call) => JSON.parse((call[1] as RequestInit).body as string));

const textareaValue = (wrapper: VueWrapper) =>
  (wrapper.find("textarea").element as HTMLTextAreaElement).value;

describe("MemoWidget 缓存一致性回归", () => {
  beforeEach(() => {
    localStorage.clear();
    mockPut.mockReset();
    mockPut.mockResolvedValue(1);
    mockGet.mockReset();
    mockGet.mockResolvedValue(undefined);
    wsSendMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse((init.body as string) || "{}");
        return jsonResponse({
          success: true,
          data: { content: body.content, server_ts: 101, mode: body.mode || "simple" },
        });
      }
      return jsonResponse({
        success: true,
        data: { content: "服务端内容", server_ts: 100, mode: "simple" },
      });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("IndexedDB 里的旧缓存（未标记未同步）不会被自动推回服务端", async () => {
    mockGet.mockResolvedValue(idbRecord("早就删掉的旧备忘", { pending: false, serverTs: 1 }));

    const ref = makeWidget({ content: "服务端新内容", server_ts: 500, mode: "simple" });
    const wrapper = mount(MemoWidget, { props: ref as never });
    await flush(2500);

    expect(putCalls()).toHaveLength(0);
    expect(textareaValue(wrapper)).toBe("服务端新内容");
  });

  it("IndexedDB 缓存不会覆盖服务端更新的内容", async () => {
    mockGet.mockResolvedValue(idbRecord("本地旧副本", { pending: false, serverTs: 10 }));

    const ref = makeWidget({ content: "服务端新内容", server_ts: 900, mode: "simple" });
    const wrapper = mount(MemoWidget, { props: ref as never });
    await flush(2500);

    expect(textareaValue(wrapper)).toBe("服务端新内容");
    expect(putBodies().some((body) => body.content === "本地旧副本")).toBe(false);
  });

  it("IndexedDB 中标记为未同步的本地改动会在启动后推送", async () => {
    mockGet.mockResolvedValue(idbRecord("离线时写的内容", { pending: true, serverTs: 100 }));

    const ref = makeWidget({ content: "服务端旧内容", server_ts: 100, mode: "simple" });
    const wrapper = mount(MemoWidget, { props: ref as never });
    await flush(2500);

    expect(textareaValue(wrapper)).toBe("离线时写的内容");
    expect(putBodies().some((body) => body.content === "离线时写的内容")).toBe(true);
  });

  it("离线清空（pending 且内容为空）不会被服务端旧内容覆盖", async () => {
    mockGet.mockResolvedValue(idbRecord("", { pending: true, serverTs: 100 }));

    const ref = makeWidget({ content: "服务端旧内容", server_ts: 100, mode: "simple" });
    const wrapper = mount(MemoWidget, { props: ref as never });
    await flush(2500);

    expect(textareaValue(wrapper)).toBe("");
    expect(putBodies().some((body) => body.content === "")).toBe(true);
  });

  it("服务端返回 409 时不再静默用本地覆盖远端，而是提示冲突", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(
          {
            error: "Version conflict",
            data: { content: "远端新内容", server_ts: 200, mode: "simple" },
          },
          409,
        );
      }
      return jsonResponse({
        success: true,
        data: { content: "base", server_ts: 100, mode: "simple" },
      });
    });

    const ref = makeWidget({ content: "base", server_ts: 100, mode: "simple" });
    const wrapper = mount(MemoWidget, { props: ref as never });
    await flush(1000);

    const textarea = wrapper.find("textarea");
    await textarea.setValue("本地新内容");
    await flush(2500);

    // 只发了一次 PUT，没有"自动带上服务端 server_ts 再覆盖一次"
    expect(putCalls()).toHaveLength(1);
    // 冲突提示出现，交由用户决定
    expect(wrapper.find(".text-red-600").exists()).toBe(true);
    // 本地内容没有被远端静默替换
    expect(textareaValue(wrapper)).toBe("本地新内容");
  });

  it("有未同步改动时，远端 widget.data 更新不会覆盖本地编辑", async () => {
    const ref = makeWidget({ content: "base", server_ts: 100, mode: "simple" });
    const wrapper = mount(MemoWidget, { props: ref as never });
    await flush(1000);

    // 先做本地编辑但不等待保存完成
    await wrapper.find("textarea").setValue("本地正在编辑");
    await nextTick();

    // 远端带着更高的 server_ts 到达
    await wrapper.setProps({
      widget: {
        ...(ref.widget as unknown as Record<string, unknown>),
        data: { content: "远端内容", server_ts: 999, mode: "simple" },
      } as unknown as WidgetConfig,
    });
    await nextTick();

    expect(textareaValue(wrapper)).toBe("本地正在编辑");
  });
});
