import { describe, expect, it } from 'vitest';
import { classifySwipe, pullsPastBottom } from './swipe';

describe('classifySwipe', () => {
  it('左へ払うと次、右へ払うと前', () => {
    expect(classifySwipe(-120, 0)).toBe('next');
    expect(classifySwipe(120, 0)).toBe('prev');
  });

  it('横の移動が短いものは記事送りにしない', () => {
    // 本文を読みながらの指のぶれで記事が飛ぶと、読んでいる場所を見失う
    expect(classifySwipe(-30, 0)).toBeNull();
    expect(classifySwipe(0, 0)).toBeNull();
  });

  it('縦に流れた指はスクロールとみなす', () => {
    expect(classifySwipe(-100, 100)).toBeNull();
    // 斜めでも横が十分に勝っていれば記事送り
    expect(classifySwipe(-200, 60)).toBe('next');
  });

  it('向きは横の符号だけで決まる（縦の向きに引きずられない）', () => {
    expect(classifySwipe(-100, -50)).toBe('next');
    expect(classifySwipe(100, 50)).toBe('prev');
  });
});

describe('pullsPastBottom', () => {
  it('下端からさらに引き上げたら次の記事へ', () => {
    expect(pullsPastBottom(0, -120)).toBe(true);
  });

  it('引きが浅いうちは何もしない', () => {
    // 読み終わりの数行を送る指と地続きなので、浅い動きで飛ばしてはいけない
    expect(pullsPastBottom(0, -40)).toBe(false);
    expect(pullsPastBottom(0, 0)).toBe(false);
  });

  it('下に引いた指は対象外（前の記事には戻さない）', () => {
    expect(pullsPastBottom(0, 120)).toBe(false);
  });

  it('横に流れた指は左右スワイプに譲る', () => {
    expect(pullsPastBottom(-140, -120)).toBe(false);
    // 同じ指が両方に当たることは無い（割合を対称にしてある）
    expect(classifySwipe(-140, -120)).toBeNull();
  });
});
