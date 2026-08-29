/**
 * 「同じフィードの別の記事に、そっくり同じ文章が出てくるなら、それは本文ではない」
 * という 1 つの規則（M7 の全文取得、issue #9）。
 *
 * 本文は記事ごとに違う。これが本文の唯一の定義で、リンク率や文字量のような
 * ヒューリスティックと違って外れようがない。サイトの外枠（著作権表記・著者
 * プロフィール・定型の注意書き）は逆に、どの記事にも同じものが出る。
 *
 * feedla（github.com/tokuhirom/feedla の internal/fulltext/boilerplate）が
 * 同じ考えで外枠を**削って**から Readability に渡している。こちらは削らず、
 * **本文の入れ物として選ばない**ことだけに使う。削らないので、feedla が要る
 * 「リンク率 50% 以上のものだけ削る」という安全弁（連載の定型前書きを本文から
 * 落とさないための条件）が要らない。実測した外枠はどれもリンクを含まない散文
 * （朝日新聞の著作権表記、KAI-YOU の編集部紹介）で、その安全弁があると
 * 1 つも落とせなかった。
 *
 * 突き合わせるのは 1 回のクロールで取れたページの中だけ。フィード単位に出現
 * 回数を貯める（feedla のやり方）と マイグレーションが 1 本増えるが、
 * Ratatoskr は**本文の位置をフィードにつき 1 回しか決めない**ので、決める
 * その回に手元にある 10 ページで足りる。
 */

import type { Candidate } from './extract';

/** 外枠とみなすのに要る最小の出現ページ数。2 は「そもそも繰り返している」の最小値 */
const MIN_REPEAT_PAGES = 2;

/**
 * 複数のページに同じ文章で現れた候補の指紋を返す。
 *
 * **突き合わせるのは 3 ページまで**（fulltext.ts の MAX_SELECTOR_TRIALS）なので、
 * 判定は「2 ページ以上に出れば外枠」がすべて。feedla は履歴を貯めて 100 ページ
 * 単位で数えるため「出現が半数に満たなければ外枠とみなさない」という条件を置いて
 * いるが、3 ページの窓ではそれが常に真になる。**常に真の条件を書くと、読む人に
 * 守られていると誤解させる**ので持ち込まない。
 *
 * 渡すのは**別々のページ**の候補一覧。1 ページに複数の記事が並ぶサイトで同じ
 * ページを 2 回渡すと、本文まで「繰り返し」に見えてしまう。
 */
export function repeatedSignatures(pages: readonly (readonly Candidate[])[]): Set<string> {
  const seen = new Map<string, number>();
  for (const candidates of pages) {
    // 同じページの中に同じ文章の入れ物が入れ子で並ぶ（本文 div とその親）ので、
    // ページごとに 1 回だけ数える
    for (const signature of new Set(candidates.map((candidate) => candidate.signature))) {
      seen.set(signature, (seen.get(signature) ?? 0) + 1);
    }
  }

  const repeated = new Set<string>();
  for (const [signature, count] of seen) {
    if (count >= MIN_REPEAT_PAGES) repeated.add(signature);
  }
  return repeated;
}

/**
 * 抜いた本文が、記事によらず全て同じになっていないか。
 *
 * **セレクタが外枠を指していることの、最も直接的な証拠。** 結城浩の日記では
 * 著者プロフィールの入れ物がセレクタとして保存され、全 15 件の全文が同じ
 * 1329 バイトになっていた（実測）。点数にも長さにも表れないので、突き合わせる
 * まで気付けない。
 *
 * **一部が一致しただけでは疑わない。** フィードは同じ記事を別の URL で 2 度配る
 * ことがあり（転載、パラメータ違い、別 URL から同じページへのリダイレクト）、
 * それは本当に同じ記事なのでセレクタの誤りではない。外枠を掴んでいるなら
 * **どの記事も**同じ本文になるので、全一致に絞っても取り逃さない。
 *
 * 記事 URL が 1 つしか無ければ判断できない。同じ記事が 2 度出ているだけの
 * 可能性が残るので、疑わない側に倒す。
 */
export function bodiesCollapsed(bodies: readonly { url: string; fullBody: string }[]): boolean {
  if (bodies.length < 2) return false;
  if (new Set(bodies.map((body) => body.url)).size < 2) return false;
  return bodies.every((body) => body.fullBody === bodies[0].fullBody);
}
