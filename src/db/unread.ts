/**
 * 未読判定の定義。ここ 1 箇所に置いて、未読数の集計と未読記事の抽出で必ず同じ
 * 条件を使う（食い違うと「未読 0 件なのに記事が出てくる」が起きる）。
 *
 * 基本はウォーターマーク（entries.id > feeds.read_seq）。
 * entry_states に行がある記事だけが例外で、そちらの値を優先する。
 *
 * 使う側は entries を e、feeds を f、entry_states を s の別名で結合すること。
 */
export const UNREAD_JOIN = 'LEFT JOIN entry_states s ON s.entry_id = e.id';

export const UNREAD_PREDICATE =
  'COALESCE(s.unread, CASE WHEN e.id > f.read_seq THEN 1 ELSE 0 END) = 1';

/**
 * 1 フィードの未読数を数える相関副問い合わせ。外側の feeds を f で結合していること。
 *
 * 未読数を出す箇所が増えても条件が食い違わないよう、式ごとここに置く
 * （一覧の取得と、書き込み後に返す状態の 2 箇所で使う）。
 */
export const UNREAD_COUNT_SUBQUERY = `(SELECT COUNT(*)
             FROM entries e
             ${UNREAD_JOIN}
            WHERE e.feed_id = f.id AND ${UNREAD_PREDICATE})`;
