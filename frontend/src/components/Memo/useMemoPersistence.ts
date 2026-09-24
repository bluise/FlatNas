import { openDB, type IDBPDatabase } from 'idb';
import { ref, type Ref } from 'vue';

const DB_NAME = 'flatnas-memo-db';
const STORE_NAME = 'memos';
const HISTORY_STORE = 'memo_versions';
const DB_VERSION = 2;
/** 每个备忘最多保留的历史版本数 */
const MAX_MEMO_VERSIONS = 30;

interface MemoData {
  id: string | number;
  content: string; // The rich text HTML
  simple?: string; // Plain text
  mode: 'simple' | 'rich';
  updatedAt: number;
  checksum: string;
  /**
   * 本地改动是否尚未成功写入服务端。
   * 之前 IndexedDB 只是一份"盲缓存"：启动时无条件覆盖内存内容并触发自动保存，
   * 会把旧备忘（包括已经在别的设备删掉的内容）重新推回服务端。
   * 现在只有 pending=true 的本地记录才允许在启动时优先于服务端。
   */
  pending?: boolean;
  /** 记录该内容对应的服务端 server_ts，便于离线改动恢复后做乐观锁校验。 */
  serverTs?: number;
}

export interface MemoVersion {
  id: string;
  widgetId: string | number;
  content: string;
  mode: 'simple' | 'rich';
  updatedAt: number;
  checksum: string;
}

// Simple checksum (DJB2)
function generateChecksum(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// Mock Sentry
const reportError = (error: unknown, context: string) => {
  console.error(`[Sentry Report] ${context}:`, error);
  const sentry = (window as {
    Sentry?: {
      captureException: (err: unknown, options?: { tags?: Record<string, string> }) => void;
    };
  }).Sentry;
  if (sentry) sentry.captureException(error, { tags: { context } });
};

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          const store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
          store.createIndex('by-widget', 'widgetId');
        }
      },
    });
  }
  return dbPromise;
}

const lastVersionChecksum = new Map<string | number, string>();
// 版本快照的排序键。Date.now() 在同一毫秒内多次保存会并列，
// 导致裁剪保留哪一条、下拉列表的先后都不确定，这里保证严格递增。
let lastSnapshotAt = 0;

export function useMemoPersistence(
  widgetId: string | number,
  localData: Ref<string>,
  mode: Ref<'simple' | 'rich'>,
  serverTs?: Ref<number>
) {
  const status = ref<'idle' | 'saving' | 'success' | 'error'>('idle');
  const progress = ref(0);

  const saveToIndexedDB = async (options: { pending?: boolean } = {}, retryCount = 0) => {
    status.value = 'saving';
    progress.value = 30;

    try {
      const db = await getDB();
      const content = localData.value;
      const checksum = generateChecksum(content);

      const data: MemoData = {
        id: widgetId,
        content,
        mode: mode.value,
        updatedAt: Date.now(),
        checksum,
        // 默认视为"本地有未同步改动"，只有服务端确认后才显式传 pending: false
        pending: options.pending ?? true,
        serverTs: serverTs?.value ?? 0,
      };

      progress.value = 60;
      await db.put(STORE_NAME, data);

      // Verify
      const saved = await db.get(STORE_NAME, widgetId) as MemoData | undefined;
      if (!saved || saved.checksum !== checksum) {
        throw new Error('Checksum validation failed');
      }
      lastVersionChecksum.set(widgetId, checksum);

      progress.value = 100;
      status.value = 'success';

      // Reset status after animation
      setTimeout(() => {
        status.value = 'idle';
        progress.value = 0;
      }, 1200);

    } catch (e) {
      console.error(`Save failed (attempt ${retryCount + 1})`, e);
      if (retryCount < 3) {
        setTimeout(() => saveToIndexedDB(options, retryCount + 1), 500 * (retryCount + 1));
      } else {
        status.value = 'error';
        reportError(e, 'MemoPersistenceSave');
      }
    }
  };

  /**
   * 读取本地缓存记录。
   * 注意：不再直接改写 localData / mode —— 本地缓存可能在服务端已经被删除或修改，
   * 是否采用要由调用方结合服务端状态决定。
   */
  const loadFromIndexedDB = async (): Promise<MemoData | null> => {
    try {
      const db = await getDB();
      const data = await db.get(STORE_NAME, widgetId) as MemoData | undefined;
      if (data) {
        // Validate checksum
        const currentChecksum = generateChecksum(data.content);
        if (currentChecksum === data.checksum) {
          lastVersionChecksum.set(widgetId, data.checksum);
          return data;
        }
        reportError(new Error('Data corruption detected on load'), 'MemoPersistenceLoad');
        return null;
      }
      // Fallback migration: import legacy LocalStorage cache if present
      const legacyKey = `flatnas-memo-backup-${widgetId}`;
      const legacyValue = localStorage.getItem(legacyKey);
      if (legacyValue && legacyValue.length > 0) {
        // Heuristic: if contains HTML tags, treat as rich
        const importMode: 'simple' | 'rich' = /<[^>]+>/.test(legacyValue) ? 'rich' : 'simple';
        // Persist into IndexedDB immediately
        const checksum = generateChecksum(legacyValue);
        const imported: MemoData = {
          id: widgetId,
          content: legacyValue,
          mode: importMode,
          updatedAt: Date.now(),
          checksum,
          // 老 localStorage 备份属于未确认同步的数据，标记为待同步
          pending: true,
          serverTs: serverTs?.value ?? 0,
        };
        await db.put(STORE_NAME, imported);
        lastVersionChecksum.set(widgetId, checksum);
        // Clean up legacy key to avoid confusion
        try { localStorage.removeItem(legacyKey); } catch {}
        return imported;
      }
      return null;
    } catch (e) {
      reportError(e, 'MemoPersistenceLoad');
      return null;
    }
  };

  const saveVersionSnapshot = async (force = false) => {
    try {
      const db = await getDB();
      const content = localData.value;
      const checksum = generateChecksum(content);
      const lastChecksum = lastVersionChecksum.get(widgetId);
      if (!force && checksum === lastChecksum) return;
      const now = Date.now();
      const updatedAt = now > lastSnapshotAt ? now : lastSnapshotAt + 1;
      lastSnapshotAt = updatedAt;
      const data: MemoVersion = {
        id: `${widgetId}-${updatedAt}-${Math.random().toString(36).slice(2, 8)}`,
        widgetId,
        content,
        mode: mode.value,
        updatedAt,
        checksum
      };
      await db.put(HISTORY_STORE, data);
      lastVersionChecksum.set(widgetId, checksum);
      await pruneVersions(db);
    } catch (e) {
      reportError(e, 'MemoPersistenceSnapshot');
    }
  };

  /**
   * 只保留最近 MAX_MEMO_VERSIONS 个历史版本。
   * 版本历史原先只增不删，长期使用会一直占用 IndexedDB，
   * 而且版本下拉里的陈旧条目也很容易被误点导致"旧内容又回来"。
   */
  const pruneVersions = async (db: IDBPDatabase) => {
    try {
      const items = (await db.getAllFromIndex(HISTORY_STORE, 'by-widget', widgetId)) as MemoVersion[];
      if (items.length <= MAX_MEMO_VERSIONS) return;
      const stale = items
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(MAX_MEMO_VERSIONS);
      for (const item of stale) {
        await db.delete(HISTORY_STORE, item.id);
      }
    } catch (e) {
      reportError(e, 'MemoPersistencePrune');
    }
  };

  const loadVersions = async () => {
    try {
      const db = await getDB();
      const items = await db.getAllFromIndex(HISTORY_STORE, 'by-widget', widgetId);
      return (items as MemoVersion[]).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {
      reportError(e, 'MemoPersistenceHistoryLoad');
      return [];
    }
  };

  const deleteVersion = async (versionId: string) => {
    try {
      const db = await getDB();
      await db.delete(HISTORY_STORE, versionId);
    } catch (e) {
      reportError(e, 'MemoPersistenceHistoryDelete');
    }
  };

  return {
    saveToIndexedDB,
    loadFromIndexedDB,
    saveVersionSnapshot,
    loadVersions,
    deleteVersion,
    status,
    progress
  };
}
