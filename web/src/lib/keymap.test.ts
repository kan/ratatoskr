import { describe, expect, it } from 'vitest';
import { KEYMAP, resolveBinding } from './keymap';

/**
 * ヘルプに載っているキーが実際に効くことの確認。
 * 表（KEYMAP）と判定（resolveBinding）が別々に書かれていると、片方だけ直して
 * 「ヘルプにはあるのに動かない」が生まれる。ここでその 2 つを突き合わせる。
 */

interface EventLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  code?: string;
}

function press(event: EventLike): KeyboardEvent {
  return {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    code: '',
    ...event,
  } as KeyboardEvent;
}

describe('resolveBinding', () => {
  it.each(KEYMAP.map((binding) => [binding.label, binding]))(
    '%s が定義どおりの動作に解決される',
    (_label, binding) => {
      const action = resolveBinding(
        press({ key: binding.key, shiftKey: binding.shift ?? false }),
      )?.action;
      expect(action).toBe(binding.action);
    },
  );

  it('Space は code からも拾う（配列によっては key が空になる）', () => {
    expect(resolveBinding(press({ key: '', code: 'Space' }))?.action).toBe('pageDown');
    expect(resolveBinding(press({ key: '', code: 'Space', shiftKey: true }))?.action).toBe(
      'pageUp',
    );
  });

  it('修飾キー付きはブラウザに譲る', () => {
    expect(resolveBinding(press({ key: 'j', ctrlKey: true }))).toBeNull();
    expect(resolveBinding(press({ key: 'j', metaKey: true }))).toBeNull();
    expect(resolveBinding(press({ key: 'j', altKey: true }))).toBeNull();
  });

  it('定義されていないキーは無視する', () => {
    expect(resolveBinding(press({ key: 'x' }))).toBeNull();
    expect(resolveBinding(press({ key: 'J', shiftKey: true }))).toBeNull();
  });

  it('ヘルプの表記が重複していない', () => {
    const labels = KEYMAP.map((binding) => binding.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('同じキーを分け合う組は Shift の有無で区別される', () => {
    const byKey = new Map<string, number>();
    for (const binding of KEYMAP) byKey.set(binding.key, (byKey.get(binding.key) ?? 0) + 1);

    for (const [key, count] of byKey) {
      if (count === 1) continue;
      const shiftFlags = KEYMAP.filter((b) => b.key === key).map((b) => b.shift ?? false);
      expect(new Set(shiftFlags).size).toBe(count);
    }
  });
});
