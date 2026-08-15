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

/** XML としては読めたが、RSS/Atom/RDF のいずれとも解釈できなかった */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
