import { ApiError } from './errors';

/**
 * クエリパラメータの読み取り。外部から来る値なので、必ずここで検証してから使う。
 * 範囲外は黙って丸めず 400 にする（クライアントの取り違えを早く見つけるため）。
 */

export function intParam(
  url: URL,
  name: string,
  options: { default: number; min: number; max: number },
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return options.default;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ApiError('bad_request', `${name} は整数で指定する`, 400);
  }
  if (value < options.min || value > options.max) {
    throw new ApiError(
      'bad_request',
      `${name} は ${options.min} 以上 ${options.max} 以下で指定する`,
      400,
    );
  }
  return value;
}

export function optionalIntParam(
  url: URL,
  name: string,
  options: { min: number; max: number },
): number | null {
  if (url.searchParams.get(name) === null) return null;
  return intParam(url, name, { ...options, default: options.min });
}

export function boolParam(url: URL, name: string, defaultValue: boolean): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return defaultValue;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ApiError('bad_request', `${name} は true か false で指定する`, 400);
}
