/**
 * キーバインドの一元定義。
 *
 * 個別のコンポーネントに keydown ハンドラを散らさない（CLAUDE.md）。
 * ヘルプ画面（?）も、押されたキーの判定も、この表 1 つから導く。
 * 表と判定を別々に書くと、ヘルプに載っているのに動かないキーが生まれる。
 *
 * 未実装のマイルストーンのキー（p / z / o / r / 1-5 / u）はまだ載せない。
 * ヘルプに出ているのに動かない状態を作らないため。
 */

export type Action =
  | 'nextEntry'
  | 'prevEntry'
  | 'nextFeed'
  | 'prevFeed'
  | 'readAllAndNext'
  | 'pageDown'
  | 'pageUp'
  | 'openOriginal'
  | 'toggleHelp'
  | 'closeOverlay';

export interface KeyBinding {
  /**
   * KeyboardEvent.key と比較する値。Space は ' '。
   * Shift を伴う文字キーは大文字（Shift+s なら 'S'）や記号（'?'）としてそのまま届くので、
   * 修飾キーの指定は要らない
   */
  key: string;
  /** 同じ key を Shift の有無で分けるときだけ指定する（Space と Shift+Space） */
  shift?: boolean;
  /** ヘルプに出す表記 */
  label: string;
  action: Action;
  description: string;
  /** ヘルプでの並び。同じ値は定義順 */
  group: 'move' | 'read' | 'other';
}

export const KEYMAP: readonly KeyBinding[] = [
  { key: 'j', label: 'j', action: 'nextEntry', description: '次の記事', group: 'move' },
  { key: 'k', label: 'k', action: 'prevEntry', description: '前の記事', group: 'move' },
  { key: 's', label: 's', action: 'nextFeed', description: '次のフィード', group: 'move' },
  { key: 'a', label: 'a', action: 'prevFeed', description: '前のフィード', group: 'move' },
  {
    key: 'S',
    label: 'Shift+S',
    action: 'readAllAndNext',
    description: 'このフィードを全て既読にして次へ',
    group: 'read',
  },
  {
    key: ' ',
    label: 'Space',
    action: 'pageDown',
    description: 'スクロール、下端で次の記事、最終記事で次のフィード',
    group: 'read',
  },
  {
    key: ' ',
    shift: true,
    label: 'Shift+Space',
    action: 'pageUp',
    description: '逆方向に同じ',
    group: 'read',
  },
  {
    key: 'v',
    label: 'v',
    action: 'openOriginal',
    description: '元記事を新しいタブで開く',
    group: 'read',
  },
  { key: '?', label: '?', action: 'toggleHelp', description: 'ヘルプ', group: 'other' },
  {
    key: 'Escape',
    label: 'Esc',
    action: 'closeOverlay',
    description: 'オーバーレイを閉じる',
    group: 'other',
  },
];

const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 入力欄にフォーカスがある間はキーバインドを無効化する（docs/UX.md） */
export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return TEXT_INPUT_TAGS.has(target.tagName) || target.isContentEditable;
}

/**
 * KeyboardEvent を Action に落とす。KEYMAP だけを見る。
 *
 * Ctrl / Alt / Meta が付いていたらブラウザ側のショートカットとみなして手を出さない。
 * Shift は、同じ key を分け合う組（Space と Shift+Space）でだけ見る。
 */
export function resolveAction(event: KeyboardEvent): Action | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;

  // Space は配列によって key が空文字になることがあるので code でも拾う
  const key = event.key === ' ' || event.code === 'Space' ? ' ' : event.key;
  const candidates = KEYMAP.filter((binding) => binding.key === key);

  if (candidates.length <= 1) return candidates[0]?.action ?? null;
  return candidates.find((binding) => (binding.shift ?? false) === event.shiftKey)?.action ?? null;
}

export const GROUP_LABELS: Record<KeyBinding['group'], string> = {
  move: '移動',
  read: '読む',
  other: 'その他',
};
