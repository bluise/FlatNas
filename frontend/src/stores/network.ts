import { ref } from "vue";
import { defineStore } from "pinia";
import { useAuthStore } from "./auth";
import { useConfigStore } from "./config";
import { toApiUrl } from "@/utils/runtimeUrls";
import { useStorage } from "@vueuse/core";

export const useNetworkStore = defineStore("network", () => {
  const auth = useAuthStore();
  const configStore = useConfigStore();

  // ---- Network Heartbeat ----
  const NETWORK_HEARTBEAT_INTERVAL = 10000;
  const NETWORK_HEARTBEAT_TIMEOUT = 20000;
  const NETWORK_HEARTBEAT_CHECK_INTERVAL = 3000;
  const NETWORK_HEARTBEAT_INTERVAL_LATENCY = 30000;
  const NETWORK_HEARTBEAT_TIMEOUT_LATENCY = 60000;
  const NETWORK_HEARTBEAT_CHECK_INTERVAL_LATENCY = 10000;
  let networkHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let networkHeartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  let lastNetworkHeartbeatAt = 0;
  let isNetworkSyncActive = true;
  const lastPingAt = ref(0);

  const markFresh = () => { lastPingAt.value = Date.now(); };
  const markStale = () => { lastPingAt.value = 0; };
  const isStale = (thresholdMs = 20000) => {
    if (lastPingAt.value <= 0) return true;
    return (Date.now() - lastPingAt.value) > thresholdMs;
  };

  const getHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
    return headers;
  };

  const getHeartbeatInterval = () =>
    configStore.forceNetworkMode === "latency"
      ? NETWORK_HEARTBEAT_INTERVAL_LATENCY : NETWORK_HEARTBEAT_INTERVAL;
  const getHeartbeatTimeout = () =>
    configStore.forceNetworkMode === "latency"
      ? NETWORK_HEARTBEAT_TIMEOUT_LATENCY : NETWORK_HEARTBEAT_TIMEOUT;
  const getHeartbeatCheckInterval = () =>
    configStore.forceNetworkMode === "latency"
      ? NETWORK_HEARTBEAT_CHECK_INTERVAL_LATENCY : NETWORK_HEARTBEAT_CHECK_INTERVAL;

  const emitNetworkHeartbeat = (wsSend: (msg: Record<string, unknown>) => void) => {
    const t = auth.token || localStorage.getItem("flat-nas-token");
    if (!t) return;
    wsSend({ type: "network_heartbeat", payload: { token: t } });
  };

  const updateNetworkSyncMode = (active: boolean) => {
    if (isNetworkSyncActive === active) return;
    isNetworkSyncActive = active;
  };

  const startNetworkHeartbeat = (wsSend: (msg: Record<string, unknown>) => void) => {
    if (networkHeartbeatTimer) clearInterval(networkHeartbeatTimer);
    if (networkHeartbeatCheckTimer) clearInterval(networkHeartbeatCheckTimer);
    lastNetworkHeartbeatAt = Date.now();
    emitNetworkHeartbeat(wsSend);
    networkHeartbeatTimer = setInterval(() => emitNetworkHeartbeat(wsSend), getHeartbeatInterval());
    networkHeartbeatCheckTimer = setInterval(() => {
      const active = lastNetworkHeartbeatAt > 0 && Date.now() - lastNetworkHeartbeatAt <= getHeartbeatTimeout();
      updateNetworkSyncMode(active);
    }, getHeartbeatCheckInterval());
  };

  const stopNetworkHeartbeat = () => {
    if (networkHeartbeatTimer) clearInterval(networkHeartbeatTimer);
    if (networkHeartbeatCheckTimer) clearInterval(networkHeartbeatCheckTimer);
    networkHeartbeatTimer = null;
    networkHeartbeatCheckTimer = null;
    lastNetworkHeartbeatAt = 0;
    updateNetworkSyncMode(false);
  };

  // ---- Network events ----
  const bindNetworkEvents = (
    wsOpen: () => void,
    wsClose: () => void,
    getStatusValue: () => string,
    triggerOfflineQueueReplay: () => void,
  ) => {
    if (typeof window === "undefined") return;
    window.addEventListener("online", () => {
      console.log("[Network] Browser online event");
      if (getStatusValue() !== "OPEN") wsOpen();
      setTimeout(() => triggerOfflineQueueReplay(), 2000);
    });
    if ("connection" in navigator) {
      const conn = (navigator as Navigator & { connection: EventTarget & { effectiveType?: string } }).connection;
      if (conn && typeof conn.addEventListener === "function") {
        conn.addEventListener("change", () => {
          console.log("[Network] Connection type changed, rebuilding WS");
          if (getStatusValue() === "OPEN") { try { wsClose(); } catch { } }
          setTimeout(() => wsOpen(), 1000);
        });
      }
    }
    let lastVisibilityReplayAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const now = Date.now();
        if (now - lastVisibilityReplayAt < 10000) return;
        lastVisibilityReplayAt = now;
        if (navigator.onLine && getStatusValue() === "OPEN") {
          console.log("[Visibility] Page visible, checking offline queue");
          setTimeout(() => triggerOfflineQueueReplay(), 1000);
        }
      }
    });
  };

  // ---- Weather detection ----
  const WEATHER_STATUS_CACHE_MS = 10_000;
  const WEATHER_DEGRADED_HOLD_MS = 15_000;
  let weatherStatusLastDetectAt = 0;
  let weatherStatusLastResult: "online" | "degraded" | "offline" = "online";
  let weatherStatusDetectInFlight: Promise<"online" | "degraded" | "offline"> | null = null;
  let weatherDegradedUntil = 0;

  const detectWeatherNetworkStatus = async (force = false): Promise<"online" | "degraded" | "offline"> => {
    const now = Date.now();
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      weatherStatusLastResult = "offline";
      weatherStatusLastDetectAt = now;
      configStore.weatherNetworkStatus = "offline";
      return "offline";
    }
    if (!force && weatherDegradedUntil > now) {
      weatherStatusLastResult = "degraded";
      configStore.weatherNetworkStatus = "degraded";
      return "degraded";
    }
    if (!force && now - weatherStatusLastDetectAt < WEATHER_STATUS_CACHE_MS) {
      configStore.weatherNetworkStatus = weatherStatusLastResult;
      return weatherStatusLastResult;
    }
    if (weatherStatusDetectInFlight) return weatherStatusDetectInFlight;

    const url = `/api/rtt?t=${now}`;
    weatherStatusDetectInFlight = (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const next: "online" | "degraded" | "offline" = res.ok ? "online" : "degraded";
        if (next === "online") weatherDegradedUntil = 0;
        else weatherDegradedUntil = Date.now() + WEATHER_DEGRADED_HOLD_MS;
        weatherStatusLastResult = next;
        weatherStatusLastDetectAt = Date.now();
        configStore.weatherNetworkStatus = next;
        return next;
      } catch {
        const next: "online" | "degraded" | "offline" = "degraded";
        weatherDegradedUntil = Date.now() + WEATHER_DEGRADED_HOLD_MS;
        weatherStatusLastResult = next;
        weatherStatusLastDetectAt = Date.now();
        configStore.weatherNetworkStatus = next;
        return next;
      } finally {
        weatherStatusDetectInFlight = null;
      }
    })();
    return weatherStatusDetectInFlight;
  };

  const bindWeatherNetworkEvents = () => {
    if (typeof window === "undefined") return;
    window.addEventListener("online", () => {
      weatherDegradedUntil = 0;
      detectWeatherNetworkStatus(true);
    });
    window.addEventListener("offline", () => {
      weatherDegradedUntil = 0;
      weatherStatusLastResult = "offline";
      weatherStatusLastDetectAt = Date.now();
      configStore.weatherNetworkStatus = "offline";
    });
  };

  // ---- Custom Scripts ----
  const fetchCustomScripts = async () => {
    try {
      const headers = getHeaders();
      if (!auth.token) return;
      const res = await fetch("/api/custom-scripts", { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (Array.isArray(data.css)) configStore.appConfig.customCssList = data.css;
          if (Array.isArray(data.js)) configStore.appConfig.customJsList = data.js;
          updateCustomScripts(false);
        }
      }
    } catch (e) {
      console.error("Failed to fetch custom scripts", e);
    }
  };

  const saveCustomScripts = async () => {
    try {
      if (!auth.isLogged) return;
      const res = await fetch("/api/custom-scripts", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          css: configStore.appConfig.customCssList || [],
          js: configStore.appConfig.customJsList || [],
        }),
      });
      if (!res.ok) console.error("Failed to save custom scripts");
    } catch (e) {
      console.error("Error saving custom scripts", e);
    }
  };

  const updateCustomScripts = (doSave = true) => {
    if (configStore.appConfig.customCssList) {
      configStore.appConfig.customCss = configStore.appConfig.customCssList
        .filter((item) => item.enable)
        .map((item) => `/* ${item.name} */\n${item.content}`)
        .join("\n\n");
    }
    if (configStore.appConfig.customJsList) {
      configStore.appConfig.customJs = configStore.appConfig.customJsList
        .filter((item) => item.enable)
        .map((item) => `// ${item.name}\n${item.content}`)
        .join("\n\n");
    }
    if (doSave) saveCustomScripts();
  };

  // ---- Wallpaper ----
  const DEFAULT_WALLPAPER_NAME = "default-wallpaper.svg";
  const wallpaperListPc = useStorage<string[]>("flatnas-wallpaper-list-pc", [DEFAULT_WALLPAPER_NAME]);
  const wallpaperListMobile = useStorage<string[]>("flatnas-wallpaper-list-mobile", [DEFAULT_WALLPAPER_NAME]);

  const ensureDefaultWallpaperFirst = (list: string[]) => {
    const next = list.filter((name) => typeof name === "string" && name.length > 0);
    const noDefault = next.filter((name) => name !== DEFAULT_WALLPAPER_NAME);
    return [DEFAULT_WALLPAPER_NAME, ...noDefault];
  };

  const buildOrderedWallpaperList = (list: unknown, savedOrder: string[] | undefined) => {
    const cleanList = Array.isArray(list)
      ? list.filter((name): name is string =>
        typeof name === "string" && name.length > 0 && name !== DEFAULT_WALLPAPER_NAME)
      : [];
    const orderedList: string[] = [DEFAULT_WALLPAPER_NAME];
    const remainingList = new Set(cleanList);
    (savedOrder || []).forEach((name) => {
      if (remainingList.has(name)) { orderedList.push(name); remainingList.delete(name); }
    });
    remainingList.forEach((name) => { orderedList.push(name); });
    return orderedList;
  };

  const fetchWallpaperLists = async () => {
    const headers = getHeaders();
    const pcEndpoint = configStore.appConfig.wallpaperApiPcList || "/api/backgrounds";
    const mobileEndpoint = configStore.appConfig.wallpaperApiMobileList || "/api/mobile_backgrounds";
    try {
      const [pcRes, mobileRes] = await Promise.all([
        fetch(pcEndpoint, { headers }),
        fetch(mobileEndpoint, { headers }),
      ]);
      if (pcRes.ok) {
        wallpaperListPc.value = buildOrderedWallpaperList(await pcRes.json(), configStore.appConfig.pcWallpaperOrder);
      } else {
        wallpaperListPc.value = ensureDefaultWallpaperFirst(wallpaperListPc.value);
      }
      if (mobileRes.ok) {
        wallpaperListMobile.value = buildOrderedWallpaperList(await mobileRes.json(), configStore.appConfig.mobileWallpaperOrder);
      } else {
        wallpaperListMobile.value = ensureDefaultWallpaperFirst(wallpaperListMobile.value);
      }
    } catch (error) {
      console.error("Failed to fetch wallpaper lists", error);
      wallpaperListPc.value = ensureDefaultWallpaperFirst(wallpaperListPc.value);
      wallpaperListMobile.value = ensureDefaultWallpaperFirst(wallpaperListMobile.value);
    }
  };

  // ---- Global drag ----
  const globalDrag = ref({ active: false, isFiles: false, point: { x: 0, y: 0 }, depth: 0, scope: "" });
  let globalDragBound = false;

  const resetGlobalDrag = () => {
    globalDrag.value.active = false;
    globalDrag.value.isFiles = false;
    globalDrag.value.depth = 0;
    globalDrag.value.scope = "";
  };

  const isFilesDragEvent = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes("Files");
  };

  const resolveDragScope = (e: DragEvent) => {
    const target = e.target as HTMLElement | null;
    const scopeEl = target?.closest?.("[data-drag-scope]") as HTMLElement | null;
    return scopeEl?.dataset.dragScope || "";
  };

  const initGlobalDrag = () => {
    if (globalDragBound || typeof window === "undefined") return;
    globalDragBound = true;
    const dragReset = () => { globalDrag.value.active = false; globalDrag.value.isFiles = false; globalDrag.value.depth = 0; globalDrag.value.scope = ""; };
    window.addEventListener("dragenter", (e: DragEvent) => {
      if (!isFilesDragEvent(e)) return;
      globalDrag.value.depth += 1;
      globalDrag.value.active = true; globalDrag.value.isFiles = true;
      globalDrag.value.point = { x: e.clientX, y: e.clientY };
      globalDrag.value.scope = resolveDragScope(e);
    }, true);
    window.addEventListener("dragover", (e: DragEvent) => {
      if (!isFilesDragEvent(e)) return;
      e.preventDefault();
      globalDrag.value.active = true; globalDrag.value.isFiles = true;
      globalDrag.value.point = { x: e.clientX, y: e.clientY };
      globalDrag.value.scope = resolveDragScope(e);
    }, true);
    window.addEventListener("dragleave", () => { if (globalDrag.value.active) { globalDrag.value.depth = Math.max(0, globalDrag.value.depth - 1); if (globalDrag.value.depth === 0) dragReset(); } }, true);
    ["drop", "dragend", "pointerup", "mouseup", "blur"].forEach((evt) => { window.addEventListener(evt, dragReset, true); });
  };

  // ---- Dashboard Pulse ----
  const DASHBOARD_PULSE_INTERVAL = 15000;
  const dashboardPulseCallbacks = new Set<() => void>();
  let dashboardPulseTimer: ReturnType<typeof setInterval> | null = null;

  const startDashboardPulse = () => {
    if (dashboardPulseTimer) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (dashboardPulseCallbacks.size === 0) return;
    dashboardPulseTimer = setInterval(() => { dashboardPulseCallbacks.forEach((f) => f()); }, DASHBOARD_PULSE_INTERVAL);
  };

  const stopDashboardPulse = () => {
    if (dashboardPulseTimer) { clearInterval(dashboardPulseTimer); dashboardPulseTimer = null; }
  };

  const registerDashboardPulse = (fn: () => void) => {
    dashboardPulseCallbacks.add(fn);
    if (typeof document !== "undefined" && document.visibilityState !== "hidden") startDashboardPulse();
  };

  const unregisterDashboardPulse = (fn: () => void) => {
    dashboardPulseCallbacks.delete(fn);
    if (dashboardPulseCallbacks.size === 0) stopDashboardPulse();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stopDashboardPulse();
      else if (dashboardPulseCallbacks.size > 0) startDashboardPulse();
    });
  }

  // ---- System Config / Lucky STUN ----
  const fetchSystemConfig = async () => {
    if (import.meta.env.MODE === "test") return;
    try {
      const res = await fetch(toApiUrl("/api/system-config"));
      if (res.ok) configStore.systemConfig = await res.json();
    } catch (e) { console.error("Failed to fetch system config", e); }
  };

  const fetchLuckyStunData = async () => {
    if (import.meta.env.MODE === "test") return;
    // The backend currently exposes STUN data only via WS push.
    // Avoid probing a non-existent REST endpoint and spamming 404s.
  };

  const initEventBindings = (wsOpen: () => void, wsClose: () => void, getStatusValue: () => string, triggerOfflineQueueReplay: () => void) => {
    bindWeatherNetworkEvents();
    bindNetworkEvents(wsOpen, wsClose, getStatusValue, triggerOfflineQueueReplay);
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => { configStore.isPageUnloading = true; });
      window.addEventListener("pagehide", () => { configStore.isPageUnloading = true; });
    }
  };

  return {
    lastPingAt, isNetworkSyncActive, lastNetworkHeartbeatAt,
    markFresh, markStale, isStale,
    startNetworkHeartbeat, stopNetworkHeartbeat,
    getHeartbeatInterval, getHeartbeatTimeout, getHeartbeatCheckInterval,
    detectWeatherNetworkStatus, initEventBindings,
    fetchCustomScripts, updateCustomScripts, saveCustomScripts,
    wallpaperListPc, wallpaperListMobile, fetchWallpaperLists,
    globalDrag, initGlobalDrag,
    registerDashboardPulse, unregisterDashboardPulse, startDashboardPulse, stopDashboardPulse,
    fetchSystemConfig, fetchLuckyStunData, getHeaders,
  };
});
