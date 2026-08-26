import type { OpmlImportResponse } from '../../shared/types';
import { attr, collect, parseXml, pick } from '../crawler/xml';
import { insertFeeds, selectFeeds, type NewFeed } from '../db/feeds';
import { badRequest } from '../lib/body';
import { ApiError, json } from '../lib/errors';

/**
 * OPML の入出力（docs/API.md「OPML」）。
 *
 * 他のリーダーとの往復が目的なので、標準の属性（text / xmlUrl / htmlUrl）だけで
 * 意味が通るようにし、レートは独自の名前空間に逃がす（他のリーダーは無視する）。
 */

// **shared の REPOSITORY_URL とは別物。** これは XML 名前空間の識別子で、
// 書き出し済みの OPML を読み戻すための固定値。リポジトリを移しても変えない
const NAMESPACE = 'https://github.com/kan/ratatoskr';
/** 1 回のインポートで受ける上限。巨大な OPML でサブリクエスト上限に当たらないため */
const MAX_IMPORT = 500;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function outline(title: string, url: string, siteUrl: string | null, rate: number): string {
  const html = siteUrl === null ? '' : ` htmlUrl="${escapeXml(siteUrl)}"`;
  return (
    `<outline type="rss" text="${escapeXml(title)}" title="${escapeXml(title)}"` +
    ` xmlUrl="${escapeXml(url)}"${html} ratatoskr:rate="${rate}" />`
  );
}

export async function exportOpml(env: Env): Promise<Response> {
  const feeds = await selectFeeds(env.DB);

  // フォルダごとに入れ子にする。未分類（'')は body 直下に置く
  const byFolder = new Map<string, string[]>();
  for (const feed of feeds) {
    const lines = byFolder.get(feed.folder) ?? [];
    lines.push(
      outline(feed.title === '' ? feed.url : feed.title, feed.url, feed.siteUrl, feed.rate),
    );
    byFolder.set(feed.folder, lines);
  }

  const body: string[] = [];
  for (const line of byFolder.get('') ?? []) body.push(`    ${line}`);
  for (const [folder, lines] of byFolder) {
    if (folder === '') continue;
    body.push(`    <outline text="${escapeXml(folder)}" title="${escapeXml(folder)}">`);
    for (const line of lines) body.push(`      ${line}`);
    body.push('    </outline>');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0" xmlns:ratatoskr="${NAMESPACE}">
  <head>
    <title>Ratatoskr subscriptions</title>
  </head>
  <body>
${body.join('\n')}
  </body>
</opml>
`;

  return new Response(xml, {
    headers: {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': 'attachment; filename="ratatoskr.opml"',
      'cache-control': 'no-store',
    },
  });
}

interface ImportTarget {
  url: string;
  title: string;
  siteUrl: string | null;
  rate: number;
  folder: string;
}

/**
 * outline を辿って購読を集める。入れ子はフォルダなので、xmlUrl を持たない
 * outline の text を子のフォルダ名にする。2 階層以上は最も内側の名前を使う
 * （スキーマのフォルダは 1 階層。docs/DESIGN.md のテーブル定義）。
 *
 * 属性は接頭辞を無視して引く（xml.ts の attr）。ratatoskr:rate も rate で取れる。
 */
function collectOutlines(node: unknown, folder: string, found: ImportTarget[]): void {
  for (const child of collect(node, 'outline')) {
    const name = attr(child, 'text') ?? attr(child, 'title') ?? '';
    const url = attr(child, 'xmlUrl');

    if (url !== null && url.trim() !== '') {
      found.push({
        url: url.trim(),
        title: name.trim(),
        siteUrl: attr(child, 'htmlUrl'),
        rate: normalizeRate(attr(child, 'rate')),
        folder,
      });
      continue;
    }
    collectOutlines(child, name.trim(), found);
  }
}

/** 他のリーダーから来た OPML にレートは無い。既定は 3（docs/UX.md） */
function normalizeRate(value: string | null): number {
  const rate = Number(value);
  if (!Number.isInteger(rate) || rate < 1 || rate > 5) return 3;
  return rate;
}

/** multipart/form-data（ファイル選択）と text/x-opml の生ボディの両方を受ける */
async function readOpml(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file') ?? form.get('opml');
    if (file === null) badRequest('file パートが無い');
    return typeof file === 'string' ? file : await file.text();
  }
  return await request.text();
}

export async function importOpml(request: Request, env: Env): Promise<Response> {
  const text = await readOpml(request);
  if (text.trim() === '') badRequest('OPML が空');

  let document: unknown;
  try {
    document = parseXml(text);
  } catch {
    return badRequest('OPML として読めない');
  }

  const opmlBody = pick(pick(document, 'opml'), 'body');
  if (opmlBody === undefined) badRequest('opml/body が無い');

  const targets: ImportTarget[] = [];
  collectOutlines(opmlBody, '', targets);
  if (targets.length === 0) badRequest('購読が 1 件も入っていない');
  if (targets.length > MAX_IMPORT) {
    throw new ApiError('too_many', `一度に取り込めるのは ${MAX_IMPORT} 件まで`, 413);
  }

  const result: OpmlImportResponse = { imported: 0, skipped: 0, failed: [] };
  const rows: NewFeed[] = [];

  for (const target of targets) {
    let url: URL;
    try {
      url = new URL(target.url);
    } catch {
      result.failed.push({ url: target.url, reason: 'URL として読めない' });
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      result.failed.push({ url: target.url, reason: 'http か https ではない' });
      continue;
    }
    rows.push({
      url: url.href,
      siteUrl: target.siteUrl,
      title: target.title,
      rate: target.rate,
      folder: target.folder,
    });
  }

  // 初回クロールはしない。next_fetch_at = 0 で入れて通常の cron に拾わせる
  // （大量登録でサブリクエスト上限に当たるのを避ける。docs/API.md）
  result.imported = await insertFeeds(env.DB, rows, Math.floor(Date.now() / 1000));
  result.skipped = rows.length - result.imported;

  return json(result);
}
