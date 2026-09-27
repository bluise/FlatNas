// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import TodoWidget from "./TodoWidget.vue";
import type { WidgetConfig } from "@/types";

const { saveSingleWidgetMock, wsSendMock, fetchMock } = vi.hoisted(() => ({
  saveSingleWidgetMock: vi.fn(
    async (
      _widgetId: string,
      _payload: { data: unknown; enable: boolean },
    ): Promise<{ ok: boolean; conflict?: { currentVersion: number; widgetVersion?: number } }> => ({
      ok: true,
    }),
  ),
  wsSendMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("../stores/main", () => ({
  useMainStore: () => ({
    // 非 LAN + 未连接 socket：强制走 HTTP 轮询分支
    isLogged: true,
    isLanModeInited: true,
    effectiveIsLan: false,
    isConnected: false,
    token: "test-token",
    getHeaders: () => ({ Authorization: "Bearer test-token" }),
    saveSingleWidget: saveSingleWidgetMock,
    saveSingleWidgetOrConflict: saveSingleWidgetMock,
    wsSend: wsSendMock,
  }),
}));

vi.stubGlobal("fetch", fetchMock);

type RawTodo = { id: string; text: string; done: boolean };

const makeWidget = (data: RawTodo[]): { widget: WidgetConfig } => ({
  widget: {
    id: "todo-widget-1",
    type: "todo",
    data,
    enable: true,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  } as unknown as WidgetConfig,
});

const serverResponse = (data: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  statusText: ok ? "OK" : "Internal Server Error",
  json: async () => ({ success: true, data }),
});

const flush = async (ms = 0) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await nextTick();
};

const textsOf = (widgetRef: { widget: WidgetConfig }) =>
  (widgetRef.widget.data as RawTodo[]).map((item) => item.text);

const renderedTexts = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll("span.break-all").map((node) => node.text());

describe("TodoWidget 数据一致性回归", () => {
  beforeEach(() => {
    localStorage.clear();
    saveSingleWidgetMock.mockReset();
    saveSingleWidgetMock.mockResolvedValue({ ok: true });
    wsSendMock.mockReset();
    fetchMock.mockReset();
    // 默认：服务端为空
    fetchMock.mockResolvedValue(serverResponse([]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("勾选复选框会写回 widget.data（而不是只改副本）", async () => {
    const initial = [{ id: "a", text: "买牛奶", done: false }];
    fetchMock.mockResolvedValue(serverResponse(initial));
    const ref = makeWidget(initial);
    const wrapper = mount(TodoWidget, { props: ref as never });
    await flush();

    const checkbox = wrapper.find('input[type="checkbox"]');
    expect(checkbox.exists()).toBe(true);
    await checkbox.setValue(true);
    await flush(700);

    expect((ref.widget.data as RawTodo[])[0].done).toBe(true);
    expect(saveSingleWidgetMock).toHaveBeenCalled();
    const lastPayload = saveSingleWidgetMock.mock.calls.at(-1)?.[1] as { data: RawTodo[] };
    expect(lastPayload.data[0].done).toBe(true);
  });

  it("本地有未保存改动时，一次强制刷新不能用服务端旧数据把删除的条目复活", async () => {
    const ref = makeWidget([
      { id: "a", text: "保留", done: false },
      { id: "b", text: "要删除", done: false },
    ]);
    // 保存始终失败（模拟断网/保存失败），但服务端仍能返回旧数据
    saveSingleWidgetMock.mockResolvedValue({ ok: false });
    fetchMock.mockResolvedValue(
      serverResponse([
        { id: "a", text: "保留", done: false },
        { id: "b", text: "要删除", done: false },
      ]),
    );

    const wrapper = mount(TodoWidget, { props: ref as never });
    await flush(700);

    // 删除 "要删除"
    const targetRow = wrapper
      .findAll("div.group")
      .find((row) => row.text().includes("要删除"));
    expect(targetRow).toBeTruthy();
    await targetRow!.find("button").trigger("click");
    await nextTick();
    expect(textsOf(ref)).toEqual(["保留"]);

    // 强制刷新（等价于切回标签页 / 网络恢复）
    window.dispatchEvent(new Event("online"));
    await flush(700);

    // 删除必须保持生效，不能被服务端旧数据复活
    expect(textsOf(ref)).toEqual(["保留"]);
    expect(renderedTexts(wrapper)).toEqual(["保留"]);
  });

  it("服务端返回空数组时，不使用 localStorage 备份复活已删除数据", async () => {
    localStorage.setItem(
      "flatnas-todo-backup-todo-widget-1",
      JSON.stringify([{ id: "old", text: "早就删掉的事", done: false }]),
    );
    fetchMock.mockResolvedValue(serverResponse([]));

    const ref = makeWidget([]);
    const wrapper = mount(TodoWidget, { props: ref as never });
    await flush(700);

    expect(textsOf(ref)).toEqual([]);
    expect(wrapper.text()).not.toContain("早就删掉的事");
  });

  it("读不到服务端（离线）时才用本地备份兜底，并等待联网后同步", async () => {
    localStorage.setItem(
      "flatnas-todo-backup-todo-widget-1",
      JSON.stringify([{ id: "bak", text: "离线期间的待办", done: false }]),
    );
    fetchMock.mockRejectedValue(new Error("offline"));

    const ref = makeWidget([]);
    const wrapper = mount(TodoWidget, { props: ref as never });
    await flush(700);

    expect(textsOf(ref)).toEqual(["离线期间的待办"]);
    expect(wrapper.text()).toContain("离线期间的待办");
  });

  it("无本地改动时，服务端数据是权威的（正常同步仍然生效）", async () => {
    fetchMock.mockResolvedValue(
      serverResponse([{ id: "srv", text: "服务端新增", done: false }]),
    );

    const ref = makeWidget([]);
    const wrapper = mount(TodoWidget, { props: ref as never });
    await flush(700);

    expect(textsOf(ref)).toEqual(["服务端新增"]);
    expect(wrapper.text()).toContain("服务端新增");
  });

  it("保存失败会自动退避重试，成功后停止重试", async () => {
    vi.useFakeTimers();
    try {
      const initial = [{ id: "a", text: "买牛奶", done: false }];
      fetchMock.mockResolvedValue(serverResponse(initial));
      saveSingleWidgetMock
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValue({ ok: true });

      const ref = makeWidget(initial);
      const wrapper = mount(TodoWidget, { props: ref as never });
      // fake timers 下必须用 advanceTimersByTimeAsync 驱动微任务
      await vi.advanceTimersByTimeAsync(1);
      await nextTick();
      expect(saveSingleWidgetMock).toHaveBeenCalledTimes(0);

      await wrapper.find('input[type="checkbox"]').setValue(true);
      // 500ms 防抖 + 首次保存（失败）
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveSingleWidgetMock).toHaveBeenCalledTimes(1);

      // 第一次退避 2000ms
      await vi.advanceTimersByTimeAsync(2100);
      expect(saveSingleWidgetMock).toHaveBeenCalledTimes(2);

      // 第二次退避 4000ms -> 成功
      await vi.advanceTimersByTimeAsync(4100);
      expect(saveSingleWidgetMock).toHaveBeenCalledTimes(3);

      // 成功之后不再继续重试
      await vi.advanceTimersByTimeAsync(60000);
      expect(saveSingleWidgetMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("保存遇到 409 时弹出冲突选择，而不是静默用本地覆盖云端", async () => {
    const localItems = [{ id: "a", text: "本地条目", done: false }];
    const cloudItems = [{ id: "srv", text: "云端条目", done: false }];
    // 第一次是初始化对齐（返回本地这份），之后点"使用云端"时返回云端版本
    fetchMock
      .mockResolvedValueOnce(serverResponse(localItems))
      .mockResolvedValue(serverResponse(cloudItems));
    saveSingleWidgetMock.mockResolvedValue({
      ok: false,
      conflict: { currentVersion: 9, widgetVersion: 4 },
    });

    const ref = makeWidget(localItems);
    const wrapper = mount(TodoWidget, { props: ref as never });
    await flush(700);

    await wrapper.find('input[type="checkbox"]').setValue(true);
    await flush(1000);

    // 冲突条出现，且只发了一次请求（没有静默重试覆盖云端）
    expect(wrapper.text()).toContain("检测到版本冲突");
    expect(saveSingleWidgetMock).toHaveBeenCalledTimes(1);
    // 本地内容保持不变
    expect(textsOf(ref)).toEqual(["本地条目"]);

    // 选择"使用云端"：拉取服务端内容并替换本地
    const remoteButton = wrapper
      .findAll("button")
      .find((b) => b.text().includes("使用云端"));
    expect(remoteButton).toBeTruthy();
    await remoteButton!.trigger("click");
    await flush(200);

    expect(textsOf(ref)).toEqual(["云端条目"]);
    expect(wrapper.text()).not.toContain("检测到版本冲突");
  });

  it("冲突中选择保留本地会重发保存并解除冲突", async () => {
    const initial = [{ id: "a", text: "本地条目", done: false }];
    fetchMock.mockResolvedValue(serverResponse(initial));
    saveSingleWidgetMock
      .mockResolvedValueOnce({ ok: false, conflict: { currentVersion: 9, widgetVersion: 4 } })
      .mockResolvedValue({ ok: true });

    const ref = makeWidget(initial);
    const wrapper = mount(TodoWidget, { props: ref as never });
    await flush(700);

    await wrapper.find('input[type="checkbox"]').setValue(true);
    await flush(1000);
    expect(wrapper.text()).toContain("检测到版本冲突");

    const localButton = wrapper
      .findAll("button")
      .find((b) => b.text().includes("保留本地"));
    expect(localButton).toBeTruthy();
    await localButton!.trigger("click");
    await flush(200);

    expect(saveSingleWidgetMock).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).not.toContain("检测到版本冲突");
    expect(textsOf(ref)).toEqual(["本地条目"]);
  });

  it("缺失 id / 重复 id 的旧数据会被修复为唯一 id", async () => {
    const legacy = [
      { text: "没有 id", done: false },
      { id: "dup", text: "重复一", done: false },
      { id: "dup", text: "重复二", done: false },
    ];
    // 服务端返回同一份旧数据，避免初始化拉取把它覆盖掉
    fetchMock.mockResolvedValue(serverResponse(legacy));

    const ref = makeWidget(legacy as unknown as RawTodo[]);

    mount(TodoWidget, { props: ref as never });
    await flush(700);

    const ids = (ref.widget.data as RawTodo[]).map((item) => item.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(textsOf(ref)).toEqual(["没有 id", "重复一", "重复二"]);
  });
});
