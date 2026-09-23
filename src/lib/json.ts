/**
 * 外から来た JSON を読むための型ガード。
 *
 * 外部 API の応答は形を信用せず、欄ごとにここで確かめてから使う（CLAUDE.md の
 * コーディング規約）。**期待と違う形は null（配列は空）に倒す**ので、呼び出し側は
 * 「無かった」と同じ扱いで先へ進める。
 */

/** 文字列を JSON として読む。壊れていれば null（「無かった」と同じ扱いにする） */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 整数だけを通す。位置やバイト数に使うので、小数は壊れた値として扱う */
export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
