
// @vitest-environment jsdom
import { mount, VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MemoWidget from '../MemoWidget.vue';

// Mock IDB
vi.mock('idb', () => ({
  openDB: vi.fn().mockResolvedValue({
    put: vi.fn(),
    get: vi.fn(),
    getAllFromIndex: vi.fn().mockResolvedValue([]),
    objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
    createObjectStore: vi.fn(),
    delete: vi.fn(),
  })
}));

// Mock Store
const mockStore = {
  isLogged: true,
  isConnected: true,
  getHeaders: () => ({ Authorization: 'Bearer token' }),
  socket: { connected: true, emit: vi.fn(), on: vi.fn(), off: vi.fn() }
};

vi.mock('../../stores/main', () => ({
  useMainStore: () => mockStore
}));

// Mock Config
vi.mock('../../config', () => ({
  CONFIG: {
    POLL_ACTIVE_INTERVAL: 1000,
    ACTIVE_INPUT_WINDOW: 2000,
    INPUT_COOLDOWN: 1000
  }
}));

type FetchResponse = {
  ok: boolean;
  status?: number;
  headers: Headers;
  json: () => Promise<unknown>;
};

const jsonResponse = (body: unknown, status = 200): FetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
});

describe('MemoWidget Conflict Reproduction', () => {
  let wrapper: VueWrapper;
  let fetchMock: typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn() as unknown as typeof fetch;
    global.fetch = fetchMock;

    // Default fallback
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ success: true, data: { content: "", server_ts: 0 } }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reproduces version conflict when rapid saves occur with network delay', async () => {
    wrapper = mount(MemoWidget, {
      props: {
        widget: {
          id: 'test-widget',
          type: 'memo',
          data: { simple: 'initial', server_ts: 100 },
          x: 0, y: 0, w: 1, h: 1,
          enable: true,
          isPublic: false
        }
      }
    });

    await flushPromises();
    await nextTick();

    // Prepare promises
    let resolveFirstFetch!: (value: FetchResponse) => void;
    const firstFetchPromise = new Promise<FetchResponse>((resolve) => {
      resolveFirstFetch = resolve;
    });

    let resolveSecondFetch!: (value: FetchResponse) => void;
    const secondFetchPromise = new Promise<FetchResponse>((resolve) => {
      resolveSecondFetch = resolve;
    });

    // Custom implementation to control responses based on call order
    let callCount = 0;
    (fetchMock as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;

      if (callCount === 1) {
        return firstFetchPromise;
      }
      if (callCount === 2) {
        return secondFetchPromise;
      }

      return jsonResponse({ success: true, data: { content: "", server_ts: 0 } });
    });

    // 1. User types "A"
    const textarea = wrapper.find('textarea');
    await textarea.trigger('focus');
    await textarea.setValue('initialA');

    // 2. Advance time to trigger auto-save (800ms debounce from watch + 800ms from saveToServer)
    await vi.advanceTimersByTimeAsync(1600);

    // Check first fetch
    expect(callCount).toBe(1);
    const firstCall = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      RequestInfo | URL,
      RequestInit,
    ];
    const firstBody = JSON.parse(firstCall[1].body as string) as { server_ts?: number };
    expect(firstBody.server_ts).toBe(100);
    // expect(firstBody.content).toBe('initialA'); // Might be initialAB if logic is fast, but let's check

    // 3. User types "B" (triggering pending save logic)
    await textarea.setValue('initialAB');

    // 4. Advance time again
    await vi.advanceTimersByTimeAsync(1600);

    // Should still be 1 call because first is pending
    expect(callCount).toBe(1);

    // 5. Resolve first fetch
    resolveFirstFetch!(
      jsonResponse({
        success: true,
        data: { content: "initialA", server_ts: 101 },
      }),
    );

    await flushPromises();

    // Now pending save should trigger
    expect(callCount).toBe(2);

    const secondCall = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as [
      RequestInfo | URL,
      RequestInit,
    ];
    const secondBody = JSON.parse(secondCall[1].body as string) as {
      server_ts?: number;
      content?: string;
    };
    expect(secondBody.server_ts).toBe(101); // Fix verification
    expect(secondBody.content).toBe('initialAB');

    // 6. Resolve second fetch
    resolveSecondFetch!(
      jsonResponse({
        success: true,
        data: { content: "initialAB", server_ts: 102 },
      }),
    );

    await flushPromises();

    // 7. Verify no conflict
    const conflictMsg = wrapper.find('.text-red-600');
    expect(conflictMsg.exists()).toBe(false);
  });
});

// Helper to flush promises
const flushPromises = async () => {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(1);
  } else {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};
