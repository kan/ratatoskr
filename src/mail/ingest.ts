import PostalMime from 'postal-mime';
import { parseDate } from '../crawler/date';
import { sanitizeHtml } from '../crawler/sanitize';
import { titleFromBody } from '../crawler/title';
import { insertEntries } from '../db/entries';
import { ensureMailFeed } from '../db/feeds';
import { sha256Hex } from '../lib/hash';
import { cleanMailHtml, textToHtml } from './clean';

/**
 * 購読しているメールマガジンを記事として取り込む（issue #41）。
 *
 * Cloudflare Email Routing で受けたメールを Worker の `email` ハンドラが受け取り、
 * ここに渡す（src/index.ts）。Gmail などから転送したものを受ける想定。
 *
 * - **受け付ける宛先は設定値（`EMAIL_ADDRESS`）の 1 つだけ。** 他の宛先は断る。
 *   空なら全て断る（機能を使わない既定）
 * - **送信者ごとにフィードを自動で作る。** フィードの URL は `mailto:<送信者>` で、
 *   「ソースはフィードの URL で決める」（docs/DESIGN.md）にそのまま乗る。
 *   クロールの対象からは外す（src/db/feeds.ts の selectCrawlTargets）
 * - **要らない送信者は「停止」にする。** 停止したフィードに届いたメールは捨てる。
 *   解除（削除）すると、次のメールでフィードが作り直される
 * - 記事の id は受信した時点で採番されるので、既読のウォーターマーク（不変条件 1）は
 *   RSS と同じに効く。同一性は Message-ID で判定する（転送が重なっても 1 件）
 * - 本文は必ずサニタイズを通す（不変条件 4）。その前にトラッキングピクセルなどを
 *   落とす（src/mail/clean.ts）
 */

/**
 * 本文の大きさの上限（文字数）。D1 の 1 行には上限があり、それを超えると
 * SQLITE_TOOBIG で落ちる（CLAUDE.md）。メールマガジンには画像の data URI を
 * 埋め込んだ巨大なものがあるので、超えたらテキスト版に落とす
 */
const MAX_BODY = 512 * 1024;

/** 受け付ける生のメールの大きさの上限。添付ファイルの大きいメールは読まない */
export const MAX_RAW_SIZE = 10 * 1024 * 1024;

export type MailOutcome =
  | { kind: 'stored'; feedId: number; inserted: boolean }
  /** 停止したフィード宛て。捨てた */
  | { kind: 'dropped' }
  | { kind: 'rejected'; reason: string };

export interface IncomingMail {
  /** 封筒の宛先（Email Routing が渡す `message.to`） */
  to: string;
  raw: ReadableStream<Uint8Array> | string;
  rawSize: number;
}

export async function ingestMail(
  env: Pick<Env, 'DB' | 'EMAIL_ADDRESS'>,
  mail: IncomingMail,
  now: number,
): Promise<MailOutcome> {
  const accepted = env.EMAIL_ADDRESS.trim().toLowerCase();
  if (accepted === '') return { kind: 'rejected', reason: 'メールの取り込みを設定していない' };
  if (mail.to.trim().toLowerCase() !== accepted) {
    return { kind: 'rejected', reason: 'このアドレスでは受け付けていない' };
  }
  if (mail.rawSize > MAX_RAW_SIZE) return { kind: 'rejected', reason: 'メールが大きすぎる' };

  const parsed = await PostalMime.parse(mail.raw, { attachmentEncoding: 'arraybuffer' });
  const from = parsed.from;
  const sender = from !== undefined && from.group === undefined ? from : null;
  const address = sender?.address.trim().toLowerCase() ?? '';
  if (address === '') return { kind: 'rejected', reason: '送信者が分からない' };

  const feed = await ensureMailFeed(
    env.DB,
    { url: `mailto:${address}`, title: sender?.name.trim() || address },
    now,
  );
  if (feed.disabled) return { kind: 'dropped' };

  const cleaned =
    parsed.html !== undefined && parsed.html.trim() !== ''
      ? await cleanMailHtml(parsed.html)
      : { html: textToHtml(parsed.text ?? ''), webUrl: null };
  let body = await sanitizeHtml(cleaned.html, cleaned.webUrl);
  if (body.length > MAX_BODY) {
    body = await sanitizeHtml(textToHtml((parsed.text ?? '').slice(0, MAX_BODY / 2)));
  }

  const subject = (parsed.subject ?? '').replace(/\s+/g, ' ').trim();
  // Message-ID が無いメールは、送信者・件名・日付で同一性を決める（転送の重複を潰す）
  const identity = parsed.messageId ?? `${address}\n${subject}\n${parsed.date ?? ''}`;
  const inserted = await insertEntries(
    env.DB,
    [
      {
        feedId: feed.id,
        guidHash: await sha256Hex(identity),
        url: cleaned.webUrl,
        title: subject === '' ? await titleFromBody(body) : subject,
        author: sender?.name.trim() || null,
        body,
        publishedAt: dateOf(parsed.date, now),
      },
    ],
    now,
  );
  return { kind: 'stored', feedId: feed.id, inserted: inserted > 0 };
}

/**
 * Date ヘッダを Unix 秒にする。読み方はフィードの日付と同じ（src/crawler/date.ts）。
 * 送り手の時計がずれて少し未来の日付になることがある。順序は id で決まるので実害は
 * 無いが、画面に未来の日付が出ないように受信時刻で頭打ちにする
 */
function dateOf(value: string | undefined, now: number): number | null {
  const seconds = parseDate(value, now);
  return seconds === null ? null : Math.min(seconds, now);
}
