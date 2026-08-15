/**
 * fast-xml-parser が返すオブジェクトを安全に掘るためのヘルパ群。
 *
 * 名前空間接頭辞は除去しない（removeNSPrefix: false）。RDF の rdf:RDF と
 * RSS の atom:link のように、接頭辞を落とすと別物が同じキーに潰れるため。
 * 代わりに、ここでは「接頭辞を無視してローカル名で引く」形で吸収する。
 */

export type XmlNode = Record<string, unknown>;

export function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 'dc:date' → 'date'、'guid' → 'guid' */
function localName(key: string): string {
  const colon = key.lastIndexOf(':');
  return colon === -1 ? key : key.slice(colon + 1);
}

function isAttributeKey(key: string): boolean {
  return key.startsWith('@_');
}

/**
 * 子要素を名前で引く。names は優先順位付きで、先に見つかったものを返す
 * （例: content:encoded → description）。同名タグが複数ある場合は最初の 1 つ。
 */
export function pick(node: unknown, ...names: string[]): unknown {
  if (!isXmlNode(node)) return undefined;
  for (const name of names) {
    for (const key of Object.keys(node)) {
      if (isAttributeKey(key)) continue;
      if (localName(key) === name) {
        const value = node[key];
        return Array.isArray(value) ? value[0] : value;
      }
    }
  }
  return undefined;
}

/**
 * 同名の子要素を全て集めて平坦化する。
 * 1 件しか無ければ配列にならない fast-xml-parser の仕様をここで吸収する。
 */
export function collect(node: unknown, name: string): unknown[] {
  if (!isXmlNode(node)) return [];
  const found: unknown[] = [];
  for (const key of Object.keys(node)) {
    if (isAttributeKey(key)) continue;
    if (localName(key) !== name) continue;
    const value = node[key];
    if (Array.isArray(value)) found.push(...value);
    else found.push(value);
  }
  return found;
}

/** 属性を接頭辞込み・接頭辞抜きの両方で引く（rdf:about / about） */
export function attr(node: unknown, name: string): string | null {
  if (!isXmlNode(node)) return null;
  for (const key of Object.keys(node)) {
    if (!isAttributeKey(key)) continue;
    if (localName(key.slice(2)) === name) {
      const value = node[key];
      return typeof value === 'string' ? value : value == null ? null : String(value);
    }
  }
  return null;
}

/**
 * テキストを取り出す。要素が属性を持つ場合は { '#text': ... } になるので、
 * その場合も中身を拾う。空文字は null に倒す（呼び出し側の ?? を効かせるため）。
 */
export function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = text(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (isXmlNode(value)) return text(value['#text']);
  return null;
}

// rel がこれらの link は本文へのリンクではないので候補から外す
const NON_ALTERNATE_RELS = new Set([
  'self',
  'edit',
  'replies',
  'enclosure',
  'hub',
  'via',
  'search',
]);

/**
 * link を 1 つ選ぶ。RSS の `<link>本文</link>`、Atom の
 * `<link rel="alternate" href="...">`、RSS チャンネルに紛れ込む
 * `<atom:link rel="self">` の 3 パターンを同じ入口で扱う。
 */
export function firstLink(node: unknown): string | null {
  let fallback: string | null = null;
  for (const candidate of collect(node, 'link')) {
    if (typeof candidate === 'string') {
      const value = candidate.trim();
      if (value !== '') return value;
      continue;
    }
    if (!isXmlNode(candidate)) continue;
    const href = attr(candidate, 'href') ?? text(candidate);
    if (href === null) continue;
    const rel = attr(candidate, 'rel');
    if (rel !== null && NON_ALTERNATE_RELS.has(rel)) continue;
    if (rel === null || rel === 'alternate') return href.trim();
    fallback ??= href.trim();
  }
  return fallback;
}
