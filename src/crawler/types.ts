import type { FetchOutcome, FetchTarget } from './fetch';

/**
 * パーサの出力。DB の行でも API の応答でもない、その中間の素の形。
 * body はこの時点では**未サニタイズ**。DB に入れる前に必ず sanitize を通す。
 */
export interface ParsedItem {
  /** フィードが提供する guid / id / rdf:about。無ければ null */
  guid: string | null;
  url: string | null;
  title: string;
  author: string | null;
  /** 未サニタイズの HTML。空文字もあり得る */
  body: string;
  /** パースできなかった場合は null（順序は id で決まるので実害がない） */
  publishedAt: number | null;
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  items: ParsedItem[];
}

/**
 * ソース（src/crawler/source.ts）の取得結果。`FetchOutcome` の本文を、パース済みの
 * フィードに置き換えたもの
 */
export type SourceOutcome =
  | Exclude<FetchOutcome, { kind: 'fetched' }>
  | (Omit<Extract<FetchOutcome, { kind: 'fetched' }>, 'body'> & {
      /** items は新しい順に並べる（RSS の通例に合わせる。取り込みは逆順に入れる） */
      feed: ParsedFeed;
    });

export interface Source {
  fetch(target: FetchTarget, fetchImpl: typeof fetch, now: number): Promise<SourceOutcome>;
  /**
   * 更新の無いフィードの取得間隔を、どこまで延ばしてよいか（秒）。
   * 省けば既定の上限（src/crawler/schedule.ts の MAX_INTERVAL）
   */
  maxInterval?: number;
}

/** RSS を出していないが、取り込み方を決め打ちで持っているサイト */
export interface KnownSource extends Source {
  /**
   * `feeds.url` に入れる形。購読の追加はこの URL で登録し、取り込みはこの URL
   * （末尾の `/` の有無は問わない）をこのソースで読む
   */
  url: string;
  /** 購読の追加で付ける名前（初回の取得を待たずに一覧へ出すため） */
  title: string;
}

/** XML としては読めたが、RSS/Atom/RDF のいずれとも解釈できなかった */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
