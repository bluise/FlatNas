// @vitest-environment jsdom
import { mount, DOMWrapper, VueWrapper } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MemoWidget from './MemoWidget.vue';
import type { WidgetConfig } from '../types';
import { nextTick } from 'vue';

// Hoist mocks
const { mockPut, mockGet, mockFetch } = vi.hoisted(() => {
  return {
    mockPut: vi.fn(),
    mockGet: vi.fn(),
    mockFetch: vi.fn(),
  };
});

// Mock IDB
vi.mock('idb', () => ({
  openDB: vi.fn().mockResolvedValue({
    put: mockPut,
    get: mockGet,
    getAllFromIndex: vi.fn().mockResolvedValue([]),
    objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
    createObjectStore: vi.fn(),
  })
}));

// Mock Sentry
vi.stubGlobal('Sentry', {
  captureException: vi.fn()
});

vi.stubGlobal('fetch', mockFetch);

// Mock Store
vi.mock('../stores/main', () => ({
  useMainStore: vi.fn(() => ({
    isLogged: true,
    saveWidget: vi.fn(),
    getHeaders: vi.fn(() => ({})),
    socket: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    token: 'fake-token',
    user: { id: 1, username: 'test' }
  }))
}));

describe('MemoWidget', () => {
  let wrapper: VueWrapper;
  const widgetProps: { widget: WidgetConfig } = {
    widget: {
      id: '123',
      type: 'memo',
      x: 0, y: 0, w: 1, h: 1,
      data: 'initial data',
      enable: true,
      isPublic: true
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null); // Default empty DB
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { content: "server-content", server_ts: 101, mode: "simple" },
      }),
    });

    // Default Put implementation: successfully stores and prepares Get to return it
    mockPut.mockImplementation(async (store: unknown, data: unknown) => {
      mockGet.mockResolvedValue(data);
      return 1;
    });
  });

  const createWrapper = () => {
    return mount(MemoWidget, {
      props: widgetProps,
      global: {
        // No plugins needed since we mocked the store module
      }
    });
  };

  it('renders correctly', () => {
    wrapper = createWrapper();
    expect(wrapper.exists()).toBe(true);
    expect(wrapper.find('textarea').exists()).toBe(true); // Default simple mode
  });

  it('toggles mode', async () => {
    wrapper = createWrapper();
    // Use title selector since the button is now a div with title
    const toggleBtn = wrapper.find('[title="切换模式"]');
    expect(toggleBtn.exists()).toBe(true);

    await toggleBtn.trigger('click');

    // Mode should be rich now
    expect(wrapper.findComponent({ name: 'MemoEditor' }).exists()).toBe(true);
    expect(wrapper.find('textarea').exists()).toBe(false);
  });

  it('handles save with feedback', async () => {
    wrapper = createWrapper();

    // Switch to rich mode first to see the button
    const toggleBtn = wrapper.find('[title="切换模式"]');
    await toggleBtn.trigger('click');

    const saveBtn = wrapper.findAll('button').find((b: DOMWrapper<HTMLButtonElement>) => b.text().includes('保存'));

    if (!saveBtn) throw new Error('Save button not found');
    await saveBtn.trigger('click');

    // Check IDB called
    expect(mockPut).toHaveBeenCalled();

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 100));
    await nextTick();

    // Check Toast
    expect(wrapper.text()).toContain('已保存，刷新不丢失');
  });

  it('handles offline/error retry', async () => {
    // Reset mock to allow chaining
    mockPut.mockReset();

    mockPut.mockRejectedValueOnce(new Error('Network Error'))
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockImplementation(async (store: unknown, data: unknown) => {
        mockGet.mockResolvedValue(data); // Ensure verification passes on 3rd try
        return 1;
      });

    wrapper = createWrapper();

    // Switch to rich mode first to see the button
    const toggleBtn = wrapper.find('[title="切换模式"]');
    await toggleBtn.trigger('click');

    const saveBtn = wrapper.findAll('button').find((b: DOMWrapper<HTMLButtonElement>) => b.text().includes('保存'));

    if (!saveBtn) throw new Error('Save button not found');
    await saveBtn.trigger('click');

    // Wait for retries (exponential backoff: 500, 1000, 1500...)
    // Total wait > 1500ms
    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(mockPut.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps save working under 300ms tunnel forwarding latency', async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              headers: new Headers({ "content-type": "application/json" }),
              json: async () => ({
                success: true,
                data: { content: "baseline", server_ts: 101, mode: "simple" },
              }),
            });
          }, 300);
        }),
    );

    wrapper = createWrapper();
    await nextTick();

    const textarea = wrapper.find('textarea');
    await textarea.setValue('baseline');
    await textarea.trigger('blur');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/memo/123');
    expect(init.method).toBe('PUT');
  });

  it('applies remote widget data updates from store sync', async () => {
    wrapper = createWrapper();
    await nextTick();

    const remoteWidget = {
      ...widgetProps.widget,
      data: { content: 'remote sync content', server_ts: 202, mode: 'simple' as const },
    };

    await wrapper.setProps({ widget: remoteWidget });
    await nextTick();

    const textarea = wrapper.find('textarea');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('remote sync content');
  });
});
