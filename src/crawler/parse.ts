import { errorMessage } from '../lib/errors';
import { parseDate } from './date';
import { ParseError, type ParsedFeed, type ParsedItem } from './types';
import { attr, collect, firstLink, isXmlNode, parseXml, pick, text } from './xml';

/**
 * RSS 2.0 / Atom / RDF (RSS 1.0) を同じ形に均す。
 * XML として壊れている、または 3 系統のいずれでもない場合は ParseError を投げる。
 */
export function parseFeed(xml: string, now?: number): ParsedFeed {
  let doc: unknown;
  try {
    doc = parseXml(xml);
  } catch (err) {
    throw new ParseError(errorMessage(err));
  }
  if (!isXmlNode(doc)) throw new ParseError('XML のルート要素が無い');

  const rss = pick(doc, 'rss');
  if (isXmlNode(rss)) return parseRss(rss, now);

  // rdf:RDF。接頭辞を落としたローカル名で引く
  const rdf = pick(doc, 'RDF');
  if (isXmlNode(rdf)) return parseRdf(rdf, now);

  const atom = pick(doc, 'feed');
  if (isXmlNode(atom)) return parseAtom(atom, now);

  throw new ParseError('RSS 2.0 / Atom / RDF のいずれでもない');
}

function parseRss(rss: unknown, now?: number): ParsedFeed {
  const channel = pick(rss, 'channel');
  return {
    title: text(pick(channel, 'title')) ?? '',
    siteUrl: firstLink(channel),
    items: collect(channel, 'item').map((item) => toItem(item, now)),
  };
}

/**
 * RDF (RSS 1.0) はチャンネルと item が兄弟で並ぶ。item を channel の下から
 * 探しても見つからない点だけが RSS 2.0 との実質的な違い。
 */
function parseRdf(rdf: unknown, now?: number): ParsedFeed {
  const channel = pick(rdf, 'channel');
  return {
    title: text(pick(channel, 'title')) ?? '',
    siteUrl: firstLink(channel),
    items: collect(rdf, 'item').map((item) => toItem(item, now)),
  };
}

/** RSS 2.0 と RDF は要素名がほぼ共通なので同じ関数で扱う */
function toItem(item: unknown, now?: number): ParsedItem {
  const link = firstLink(item);
  return {
    // rdf:about は RDF の item を一意に指す。RSS 2.0 には無いので guid が優先される
    guid: text(pick(item, 'guid')) ?? attr(item, 'about'),
    url: link,
    title: text(pick(item, 'title')) ?? '',
    author: text(pick(item, 'creator', 'author')),
    // content:encoded は description より情報量が多いので優先する
    body: text(pick(item, 'encoded', 'description')) ?? '',
    publishedAt: parseDate(pick(item, 'pubDate', 'date'), now),
  };
}

function parseAtom(feed: unknown, now?: number): ParsedFeed {
  return {
    title: text(pick(feed, 'title')) ?? '',
    siteUrl: firstLink(feed),
    items: collect(feed, 'entry').map((entry) => ({
      guid: text(pick(entry, 'id')),
      url: firstLink(entry),
      title: text(pick(entry, 'title')) ?? '',
      author: text(pick(pick(entry, 'author'), 'name')) ?? text(pick(entry, 'author')),
      body: text(pick(entry, 'content', 'summary')) ?? '',
      // published が無いフィードは updated しか持たない
      publishedAt: parseDate(pick(entry, 'published', 'updated'), now),
    })),
  };
}
