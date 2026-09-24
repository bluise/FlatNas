<script setup lang="ts">
/* eslint-disable vue/no-mutating-props */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useStorage, useDebounceFn } from "@vueuse/core";
import type { WidgetConfig } from "@/types";
import { useMainStore } from "../stores/main";
import { useResumeRefresh } from "@/composables/useResumeRefresh";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

/**
 * 数据一致性要点（修复"待办丢失 / 已删除的又冒出来"）：
 *
 * 1. 之前模板直接遍历 `normalizeTodoItems(props.widget.data)`，而它每次都会**复制**对象，
 *    因此 `v-model="item.done"` 只改到副本，永远写不回 `widget.data`、也保存不到服务端
 *    —— 勾选状态在下一次刷新/远端同步时必然丢失。
 *    现在组件内部维护权威数组 `todoItems`，所有写操作都经过它。
 * 2. 远端（HTTP 轮询 / WebSocket / 缓存）拿到的可能是**旧数据**。之前任何一次
 *    `pollRemote(true)`（切回标签页、恢复网络、刚登录）都会直接用旧数据覆盖本地，
 *    于是刚删掉的条目又回来了。现在只要有未落盘的本地改动，远端数据一律不许覆盖本地，
 *    并且强制刷新会先把本地改动推送到服务端。
 * 3. localStorage 备份不再"看到空数组就回填并推给服务端"。只有**确实读不到服务端**
 *    （离线/请求失败）时才用备份兜底，服务端返回空视为权威结果。
 */

const props = defineProps<{ widget: WidgetConfig }>();
const store = useMainStore();
const newItem = ref("");
const saveStatus = ref<"saved" | "saving" | "unsaved">("saved");
// LAN 判定只是一种"偏好"。在隧道/反代场景下 socket 可能实际断开，
// 此时仍需要保留 HTTP 轮询兜底，避免 Todo 永久不同步。
const shouldUseSocket = computed(() => store.isLanModeInited && store.effectiveIsLan && store.isConnected);
const TODO_POLL_INTERVAL_MS = 10000;
const TODO_POLL_TIMEOUT_MS = 8000;
const TODO_LOCAL_CHANGE_GRACE_MS = 8000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollController: AbortController | null = null;
let lastLocalMutationAt = 0;

// UI 的权威数据源。不要直接渲染 props.widget.data 的副本。
const todoItems = ref<TodoItem[]>([]);
// 是否存在尚未成功写入服务端的本地改动。为真时禁止任何远端数据覆盖本地。
const hasPendingLocalChanges = ref(false);
// 最近一次已确认同步的快照，用于区分"自己写回 widget.data"和"外部写入"。
let lastSyncedSnapshot = "";

const createTodoId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * 归一化待办数据。修复两处旧问题：缺失 id 时用 Date.now() 会生成重复 id，
 * 重复 id 会让 v-for key 冲突、删除/勾选错位。
 */
const canonicalizeTodoItems = (value: unknown): TodoItem[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  value.forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const candidate = raw as Partial<TodoItem>;
    let id = typeof candidate.id === "string" && candidate.id ? candidate.id : createTodoId();
    if (seen.has(id)) id = createTodoId();
    seen.add(id);
    items.push({
      id,
      text: typeof candidate.text === "string" ? candidate.text : "",
      done: Boolean(candidate.done),
    });
  });
  return items;
};

const snapshotOf = (items: TodoItem[]) =>
  JSON.stringify(items.map((item) => ({ id: item.id, text: item.text, done: item.done })));

const cloneItems = (items: TodoItem[]) => items.map((item) => ({ ...item }));

// 本地持久化备份：仅用于"完全读不到服务端"时兜底，不作为独立数据源。
const localBackup = useStorage<TodoItem[]>(`flatnas-todo-backup-${props.widget.id}`, []);

const writeBackup = (items: TodoItem[]) => {
  localBackup.value = cloneItems(items);
};

/** 采用远端数据为最新状态（服务端/缓存权威）。 */
const applyRemoteItems = (items: TodoItem[]) => {
  todoItems.value = items;
  props.widget.data = cloneItems(items);
  hasPendingLocalChanges.value = false;
  lastSyncedSnapshot = snapshotOf(items);
  writeBackup(items);
};

/** 采纳本地改动：更新 UI、写回 widget.data，并标记为待同步。 */
const commitLocalItems = (items: TodoItem[]) => {
  todoItems.value = items;
  props.widget.data = cloneItems(items);
  hasPendingLocalChanges.value = true;
  lastLocalMutationAt = Date.now();
  saveStatus.value = "unsaved";
  // 新的本地改动重新开始一轮重试预算
  saveRetryCount = 0;
  clearSaveRetry();
  writeBackup(items);
};

/** 服务端已确认当前的本地内容，清除待同步标记。 */
const markSynced = () => {
  hasPendingLocalChanges.value = false;
  lastSyncedSnapshot = snapshotOf(todoItems.value);
  writeBackup(todoItems.value);
};

// 是否存在未解决的版本冲突。为真时暂停自动保存与远端覆盖，等用户选择。
const hasConflict = ref(false);

const stopPolling = () => {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pollController) {
    pollController.abort();
    pollController = null;
  }
};

const scheduleNextPoll = () => {
  if (pollTimer) clearTimeout(pollTimer);
  if (!store.isLogged || shouldUseSocket.value || document.visibilityState === "hidden") return;
  if (hasConflict.value) return;
  pollTimer = setTimeout(() => {
    void pollRemote();
  }, TODO_POLL_INTERVAL_MS);
};

/** 读取一次服务端数据；读不到返回 null（区别于"服务端就是空的"）。 */
const fetchRemoteItems = async (): Promise<TodoItem[] | null> => {
  pollController?.abort();
  const controller = new AbortController();
  pollController = controller;
  const timeoutTimer = setTimeout(() => controller.abort(), TODO_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/widgets/${encodeURIComponent(props.widget.id)}`, {
      headers: store.getHeaders(),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(res.statusText);
    const payload = (await res.json()) as { success?: boolean; data?: unknown };
    if (!payload.success) throw new Error("todo payload invalid");
    return canonicalizeTodoItems(payload.data);
  } catch {
    // 网络/鉴权/解析失败：交给调用方决定是否用本地备份兜底
    return null;
  } finally {
    clearTimeout(timeoutTimer);
    if (pollController === controller) {
      pollController = null;
    }
  }
};

/**
 * 拉取远端数据。
 * @returns 是否成功读取到服务端数据（用于区分"服务端为空"和"读不到服务端"）。
 */
const pollRemote = async (force = false): Promise<boolean> => {
  if (!store.isLogged) return false;
  // 冲突未解决时不拉取远端，避免"替用户做选择"
  if (hasConflict.value) return false;
  if (shouldUseSocket.value && !force) {
    stopPolling();
    return true;
  }
  if (!force) {
    if (saveStatus.value !== "saved") {
      scheduleNextPoll();
      return false;
    }
    if (Date.now() - lastLocalMutationAt < TODO_LOCAL_CHANGE_GRACE_MS) {
      scheduleNextPoll();
      return false;
    }
  }

  // 本地还有未落盘的改动时，先推送本地，再允许读取远端。
  // 否则一次强制刷新就会用服务端的旧数据抹掉本地刚做的删除（"删掉的东西又冒出来"）。
  if (hasPendingLocalChanges.value) {
    await saveNow();
    if (hasPendingLocalChanges.value) {
      scheduleNextPoll();
      return false;
    }
  }

  const nextItems = await fetchRemoteItems();
  if (!nextItems) {
    scheduleNextPoll();
    return false;
  }
  // 请求期间用户又改了：丢弃这次结果，避免覆盖更新的本地状态。
  if (hasPendingLocalChanges.value) {
    scheduleNextPoll();
    return true;
  }
  if (snapshotOf(nextItems) !== snapshotOf(todoItems.value)) {
    applyRemoteItems(nextItems);
  } else {
    lastSyncedSnapshot = snapshotOf(nextItems);
  }
  scheduleNextPoll();
  return true;
};

const pushUpdate = (data: TodoItem[]) => {
  if (!store.isLogged || !shouldUseSocket.value) return;
  try {
    store.wsSend({
      type: "todo_update",
      payload: {
        token: store.token || localStorage.getItem("flat-nas-token"),
        widgetId: props.widget.id,
        content: cloneItems(data),
      },
    });
  } catch {
    // WebSocket 失败不影响本地保存，轮询会兜底
  }
};

// 串行化保存，避免并发请求互相覆盖
let saveChain: Promise<void> = Promise.resolve();

// 保存失败后的重试（指数退避）。轮询在 socket 模式下不会调度，
// 没有这条重试链路时，一次瞬时失败就可能让本地改动一直不落盘。
const SAVE_RETRY_BASE_MS = 2000;
const SAVE_RETRY_MAX_MS = 30000;
const SAVE_RETRY_LIMIT = 5;
let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
let saveRetryCount = 0;

const clearSaveRetry = () => {
  if (saveRetryTimer) {
    clearTimeout(saveRetryTimer);
    saveRetryTimer = null;
  }
};

const scheduleSaveRetry = () => {
  if (saveRetryTimer || !hasPendingLocalChanges.value) return;
  if (hasConflict.value) return;
  if (saveRetryCount >= SAVE_RETRY_LIMIT) return;
  const delay = Math.min(SAVE_RETRY_BASE_MS * Math.pow(2, saveRetryCount), SAVE_RETRY_MAX_MS);
  saveRetryCount++;
  saveRetryTimer = setTimeout(() => {
    saveRetryTimer = null;
    void saveNow();
  }, delay);
};

/** 立即保存当前本地状态（已是最新则跳过）。 */
const saveNow = (): Promise<void> => {
  const run = async () => {
    if (!store.isLogged || !hasPendingLocalChanges.value) return;
    if (hasConflict.value) return;
    saveStatus.value = "saving";
    const sentSnapshot = snapshotOf(todoItems.value);
    const sentItems = cloneItems(todoItems.value);
    try {
      // 用"不自动重试"的版本：409 时把冲突原样交回来，由用户选择保留哪一份，
      // 而不是像以前那样静默地用本地覆盖服务端。
      const result = await store.saveSingleWidgetOrConflict(props.widget.id, {
        data: sentItems,
        enable: props.widget.enable,
      });
      if (result.conflict) {
        hasConflict.value = true;
        clearSaveRetry();
        saveStatus.value = "unsaved";
        return;
      }
      const ok = result.ok;
      if (ok) {
        saveRetryCount = 0;
        clearSaveRetry();
        if (snapshotOf(todoItems.value) === sentSnapshot) {
          markSynced();
        } else {
          // 保存期间又产生新改动：保持待同步，稍后重发
          hasPendingLocalChanges.value = true;
          void persistSave();
        }
        pushUpdate(sentItems);
      } else {
        // 服务端拒绝/网络失败：保留本地状态并退避重试
        saveStatus.value = "unsaved";
        scheduleSaveRetry();
      }
    } catch {
      saveStatus.value = "unsaved";
      scheduleSaveRetry();
    } finally {
      if (!hasPendingLocalChanges.value) {
        saveStatus.value = "saved";
      }
      scheduleNextPoll();
    }
  };
  saveChain = saveChain.then(run, run);
  return saveChain;
};

const persistSave = useDebounceFn(saveNow, 500);

/** 冲突处理：保留本地，用服务端当前版本号覆盖云端。 */
const resolveTodoConflictKeepLocal = async () => {
  hasConflict.value = false;
  hasPendingLocalChanges.value = true;
  saveRetryCount = 0;
  clearSaveRetry();
  // sendSingleWidgetSave 已把服务端版本号写入本地，重发即可通过乐观锁校验
  await saveNow();
  scheduleNextPoll();
};

/** 冲突处理：使用云端，丢弃本地改动。 */
const resolveTodoConflictUseRemote = async () => {
  const remote = await fetchRemoteItems();
  if (!remote) {
    // 读不到云端就保持冲突状态，等网络恢复后由用户再选
    return;
  }
  applyRemoteItems(remote);
  hasConflict.value = false;
  saveRetryCount = 0;
  clearSaveRetry();
  saveStatus.value = "saved";
  scheduleNextPoll();
};

// 外部（store 同步 / 缓存 / 轮询）写回 widget.data 时决定是否采纳。
// 有未落盘的本地改动时一律忽略，避免旧数据把本地改动顶掉。
watch(
  () => props.widget.data,
  (nextVal) => {
    if (hasConflict.value) return;
    const items = canonicalizeTodoItems(nextVal);
    if (hasPendingLocalChanges.value) return;
    if (snapshotOf(items) === lastSyncedSnapshot) return;
    applyRemoteItems(items);
  },
  { deep: true },
);

onMounted(() => {
  void initFromServer();
});

/**
 * 初始化：先用已有数据填充 UI，然后向服务端确认一次。
 * 只有"确实读不到服务端"（离线/请求失败）且本地无数据时才回填备份——
 * 服务端返回空视为权威结果，否则会把别的设备已经删除的旧数据又推回服务端。
 */
const initFromServer = async () => {
  const current = canonicalizeTodoItems(props.widget.data);
  if (current.length > 0) {
    applyRemoteItems(current);
  } else {
    todoItems.value = current;
    lastSyncedSnapshot = snapshotOf(current);
  }

  if (!store.isLogged || shouldUseSocket.value) return;

  const remote = await fetchRemoteItems();
  if (remote) {
    applyRemoteItems(remote);
  } else if (current.length === 0) {
    // 读不到服务端（离线）：用本地备份兜底，标记待同步，联网后推送
    const backup = canonicalizeTodoItems(localBackup.value);
    if (backup.length > 0) {
      commitLocalItems(backup);
      void persistSave();
    }
  }
  scheduleNextPoll();
};

onUnmounted(() => {
  stopPolling();
  clearSaveRetry();
});

const handleSave = () => {
  saveStatus.value = "unsaved";
  void persistSave();
};

const add = () => {
  const text = newItem.value.trim();
  if (!text) return;
  newItem.value = "";
  commitLocalItems([...todoItems.value, { id: createTodoId(), text, done: false }]);
  void persistSave();
};

const remove = (id: string) => {
  const next = todoItems.value.filter((item) => item.id !== id);
  if (next.length === todoItems.value.length) return;
  commitLocalItems(next);
  void persistSave();
};

const toggleDone = (id: string, checked: boolean) => {
  const next = todoItems.value.map((item) => (item.id === id ? { ...item, done: checked } : item));
  commitLocalItems(next);
  void persistSave();
};

useResumeRefresh({
  enabled: () => store.isLogged,
  onHidden: () => {
    stopPolling();
  },
  onVisible: () => {
    if (!shouldUseSocket.value) {
      void pollRemote(true);
    }
  },
  onOnline: () => {
    if (!shouldUseSocket.value) {
      void pollRemote(true);
    }
  },
});

watch(
  [() => store.isLogged, shouldUseSocket],
  ([isLogged, useSocket]) => {
    if (!isLogged) {
      stopPolling();
      return;
    }
    if (useSocket) {
      stopPolling();
      return;
    }
    void pollRemote(true);
  },
);

const handleScrollIsolation = (e: WheelEvent) => {
  const el = e.currentTarget as HTMLDivElement;
  const { scrollTop, scrollHeight, clientHeight } = el;
  const delta = e.deltaY;

  const isAtTop = scrollTop <= 0;
  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1;

  if ((isAtTop && delta < 0) || (isAtBottom && delta > 0)) {
    e.preventDefault();
    e.stopPropagation();
  }
};
</script>

<template>
  <div
    class="w-full h-full rounded-2xl backdrop-blur border border-white/10 overflow-hidden flex flex-col text-white p-3"
    :style="{
      backgroundColor: `rgba(0,0,0,${Math.min(0.85, Math.max(0.15, widget.opacity ?? 0.35))})`,
      color: '#fff',
    }"
  >
    <div class="font-bold text-white text-xs mb-2 flex justify-between items-center">
      <div class="flex items-center gap-2">
        <span>待办</span>
        <span
          v-if="saveStatus !== 'saved'"
          class="text-[10px] font-normal text-white/60 transition-opacity"
        >
          {{ saveStatus === "saving" ? "..." : "" }}
        </span>
      </div>
      <span class="text-[10px] text-white/60"
        >{{ todoItems.filter((i: TodoItem) => !i.done).length || 0 }} 待完成</span
      >
    </div>

    <div class="flex-1 overflow-y-auto space-y-1 scrollbar-hide" @wheel="handleScrollIsolation">
      <div v-for="item in todoItems" :key="item.id" class="flex items-start gap-2 group">
        <input
          type="checkbox"
          :checked="item.done"
          @change="toggleDone(item.id, ($event.target as HTMLInputElement).checked)"
          class="rounded text-white focus:ring-0 cursor-pointer mt-0.5"
        />
        <span
          class="text-xs flex-1 break-all whitespace-normal leading-tight"
          :class="item.done ? 'line-through' : ''"
          :style="{ color: item.done ? '#9ca3af' : '#ffffff' }"
          >{{ item.text }}</span
        >
        <button
          @click="remove(item.id)"
          class="text-xs text-white/50 hover:text-white/80 border border-white/10 rounded px-2 py-0.5 hover:bg-white/10 transition-colors whitespace-nowrap shrink-0"
        >
          删除
        </button>
      </div>
      <div v-if="!todoItems.length" class="text-xs text-white/50 text-center py-2">
        无待办事项
      </div>
    </div>

    <!-- 版本冲突：不静默替用户做选择 -->
    <div
      v-if="hasConflict"
      class="mt-2 rounded-lg border border-red-400/40 bg-red-500/20 p-2 flex flex-col gap-1.5"
    >
      <div class="text-[11px] font-bold text-red-200">检测到版本冲突</div>
      <div class="text-[10px] text-red-100/80 leading-tight">
        云端存在更新的版本。请选择保留本地更改（覆盖云端）还是使用云端版本。
      </div>
      <div class="flex gap-2">
        <button
          @click="resolveTodoConflictKeepLocal"
          class="flex-1 text-[11px] px-2 py-1 rounded bg-white/15 hover:bg-white/25 transition-colors"
        >
          保留本地
        </button>
        <button
          @click="resolveTodoConflictUseRemote"
          class="flex-1 text-[11px] px-2 py-1 rounded bg-red-500/70 hover:bg-red-500 transition-colors"
        >
          使用云端
        </button>
      </div>
    </div>

    <div class="mt-2 pt-2 border-t border-white/10 flex gap-2">
      <input
        v-model="newItem"
        @keyup.enter="add"
        placeholder="添加待办..."
        class="flex-1 text-xs bg-white/10 border border-white/20 rounded px-2 py-1 outline-none focus:bg-white/10 focus:border-white/40 transition-colors text-white placeholder-white/50"
      />
      <button
        @click="add"
        class="bg-white/10 text-white text-xs px-3 py-1 rounded hover:bg-white/20 transition-colors whitespace-nowrap"
      >
        回车
      </button>
    </div>
  </div>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
</style>
