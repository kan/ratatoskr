/**
 * 左右スワイプでの記事送り（docs/UX.md「左右スワイプで記事送り（j / k 相当）」）。
 *
 * 判定だけを持つ。実際に指を受けるのは EntryReader で、カーソルを動かすのは
 * 親（stores/feeds.ts）。ここは「その指の動きを記事送りとみなすか」しか決めない。
 */

/** 記事送りとみなす最小の横移動（px）。読みながらの小さな指のぶれで送らないため */
const MIN_DISTANCE = 60;

/**
 * 縦の移動が横に対してこの割合を超えたら捨てる。
 * スマホの本文は縦スクロールが主なので、斜めの指は**スクロールの方**に倒す
 */
const MAX_VERTICAL_RATIO = 0.7;

/** 記事送りの向き。next は j、prev は k と同じ（境界でフィードを跨ぐのも同じ） */
export type SwipeDirection = 'next' | 'prev' | null;

export function classifySwipe(dx: number, dy: number): SwipeDirection {
  if (Math.abs(dx) < MIN_DISTANCE) return null;
  if (Math.abs(dy) > Math.abs(dx) * MAX_VERTICAL_RATIO) return null;
  // 紙をめくる向きに合わせる。左へ払えば次の記事
  return dx < 0 ? 'next' : 'prev';
}

/**
 * 下端に着いた後、さらに引き上げた量。ここを超えたら記事送りとみなす。
 *
 * 左右スワイプより深くしてある。読み終わりの数行を送るだけの指と地続きの動きなので、
 * 同じ深さにすると「最後の 1 画面を送ったつもりで次の記事に飛ぶ」ことになる。
 *
 * **90 では実機で重かった**ので浅くした。深さの差（左右は 60）は残してあるので、
 * 読み送りの指との区別は付く。
 */
const PULL_DISTANCE = 70;

/**
 * 下端でさらに上へ引く指を、次の記事への要求とみなすか。
 *
 * `Space` が下端で記事送りに変わるのと同じ考え方（docs/UX.md）。読み進める向きの
 * 動きをそのまま続けると次に進む、という一続きの操作にする。
 *
 * 横に流れた指は捨てる。左右スワイプ（`classifySwipe`）と割合を対称にしてあるので、
 * 斜めの指がどちらにも当たることはない。
 *
 * @param dx 下端に着いてからの横移動
 * @param dy 同じく縦移動（上へ引くと負）
 */
export function pullsPastBottom(dx: number, dy: number): boolean {
  if (dy > -PULL_DISTANCE) return false;
  return Math.abs(dx) <= Math.abs(dy) * MAX_VERTICAL_RATIO;
}
