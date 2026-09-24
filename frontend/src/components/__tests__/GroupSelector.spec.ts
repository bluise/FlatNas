import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import GroupSelector from '../GroupSelector.vue';

describe('GroupSelector', () => {
  let wrapper: VueWrapper;

  beforeEach(() => {
    wrapper = mount(GroupSelector, {
      props: {
        modelValue: 'group-1',
      },
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            // main 是 setup store，groups 是从 groups store 透传的 computed，
            // initialState.main.groups 不会生效，必须给真正的 store 播种。
            initialState: {
              groups: {
                groups: [
                  { id: 'group-1', title: 'Group 1', items: [] },
                  { id: 'group-2', title: 'Group 2', items: [] },
                ],
              },
            },
          }),
        ],
      },
    });
  });

  it('renders correctly with initial group', () => {
    expect(wrapper.text()).toContain('Group 1');
  });

  it('opens dropdown on click', async () => {
    expect(wrapper.find('.absolute').exists()).toBe(false);
    await wrapper.find('button').trigger('click');
    expect(wrapper.find('.absolute').exists()).toBe(true);
    // Should show all groups in dropdown
    const dropdownText = wrapper.find('.absolute').text();
    expect(dropdownText).toContain('Group 1');
    expect(dropdownText).toContain('Group 2');
  });

  it('emits update:modelValue when selecting a group', async () => {
    await wrapper.find('button').trigger('click');

    // Find all group buttons inside the dropdown
    // Note: The main button is also a button, so we look inside .absolute
    const dropdown = wrapper.find('.absolute');
    const groupButtons = dropdown.findAll('button');

    // Select the second group (Group 2)
    const group2Button = groupButtons.find((btn) => btn.text().includes('Group 2'));
    if (!group2Button) {
      throw new Error('Group 2 button not found');
    }
    await group2Button.trigger('click');

    const emitted = wrapper.emitted('update:modelValue') ?? [];
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]).toEqual(['group-2']);
  });

  it('closes dropdown after selection', async () => {
    await wrapper.find('button').trigger('click');
    const dropdown = wrapper.find('.absolute');
    const groupButtons = dropdown.findAll('button');
    const group2Button = groupButtons.find((btn) => btn.text().includes('Group 2'));
    if (!group2Button) {
      throw new Error('Group 2 button not found');
    }
    await group2Button.trigger('click');

    expect(wrapper.find('.absolute').exists()).toBe(false);
  });
});
