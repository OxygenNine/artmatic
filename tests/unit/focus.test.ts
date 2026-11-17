import { describe, expect, it } from 'vitest';
import { ownsSpaceKey, shiftDigitOf } from '../../src/ui/focus';

/**
 * 这两条判据决定了「按 Space 会不会播放」。它们必须是不依赖 DOM 的纯函数 ——
 * 一旦需要 jsdom 才能测，键盘行为就只能靠 E2E 猜，而 E2E 里最容易漏的恰恰是
 * 「焦点在某个奇怪的控件上」这一类。
 */

/** 最小伪元素：只看 `tagName` 与 `role`。 */
const el = (tagName: string, role: string | null): Element =>
  ({ tagName, getAttribute: () => role }) as unknown as Element;

describe('ownsSpaceKey：Space 归控件还是归播放', () => {
  it('原生按钮与 role=button 不再吃 Space（Enter 仍能激活）', () => {
    expect(ownsSpaceKey(el('BUTTON', null))).toBe(false);
    // 时间轴片段就是这个形态：role=button 的 div。
    expect(ownsSpaceKey(el('DIV', 'button'))).toBe(false);
  });

  it('列表 / 滑杆 / 勾选框这类自研控件仍然自己吃 Space', () => {
    for (const role of [
      'checkbox',
      'combobox',
      'listbox',
      'menu',
      'menuitem',
      'option',
      'radio',
      'slider',
      'spinbutton',
      'switch',
      'tab',
    ]) {
      expect(ownsSpaceKey(el('DIV', role)), role).toBe(true);
    }
  });

  it('body / 无 role 元素 / null 都不吃 Space', () => {
    expect(ownsSpaceKey(el('BODY', null))).toBe(false);
    expect(ownsSpaceKey(null)).toBe(false);
  });
});

describe('shiftDigitOf：Shift+数字 → 面板编号', () => {
  const key = (code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({
      code,
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      ...mods,
    }) as KeyboardEvent;

  it('主键盘与小键盘都认', () => {
    expect(shiftDigitOf(key('Digit1'))).toBe(1);
    expect(shiftDigitOf(key('Digit6'))).toBe(6);
    expect(shiftDigitOf(key('Numpad2'))).toBe(2);
  });

  it('没按 Shift / 带了 Ctrl / 0 或非数字都返回 null', () => {
    expect(shiftDigitOf(key('Digit1', { shiftKey: false }))).toBe(null);
    expect(shiftDigitOf(key('Digit1', { ctrlKey: true }))).toBe(null);
    expect(shiftDigitOf(key('Digit1', { altKey: true }))).toBe(null);
    expect(shiftDigitOf(key('Digit0'))).toBe(null);
    expect(shiftDigitOf(key('KeyA'))).toBe(null);
  });
});
