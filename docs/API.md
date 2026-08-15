# API.md — Ratatoskr API 仕様

## 共通事項

- ベースパス: `/api`
- 全て JSON。リクエストボディも JSON（`application/json`）
- 認証は Cloudflare Access。Worker は `Cf-Access-Jwt-Assertion` を検証する
- 時刻は全て **Unix 秒（整数）**
- エラーレスポンス: `{ "error": { "code": "...", "message": "..." } }` + 適切な HTTP ステータス
- 型定義は `shared/types.ts` に置き、Worker と web の双方から import する

## 型定義

```ts
export interface Feed {
  id: number;
  url: string;
  siteUrl: string | null;
  title: string;
  iconUrl: string | null;
  rate: number;          // 1..5
  folder: string;        // "" は未分類
  readSeq: number;       // 既読ウォーターマーク
  unreadCount: number;
  lastFetchedAt: number | null;
  lastError: string | null;
  disabled: boolean;
}

export interface Entry {
  id: number;            // 全体単調増加。順序と未読判定の基準
  feedId: number;
  url: string | null;
  title: string;
  author: string | null;
  body: string;          // サニタイズ済み HTML
  publishedAt: number | null;
  storedAt: number;
}

export interface Pin {
  id: number;
  entryId: number | null;
  title: string;
  url: string;
  pinnedAt: number;
}
```

## 読み取り

### `GET /api/bootstrap`

起動時に 1 リクエストで必要なものを全て取得する。**このエンドポイントのレスポンスだけで操作可能な状態になること**が要件。

クエリパラメータ:

| 名前 | 既定値 | 説明 |
| --- | --- | --- |
| `feeds` | 5 | 記事本文をインラインで含めるフィード数（レート降順の上位から） |
| `entriesPerFeed` | 50 | 1 フィードあたりの記事数上限 |

```jsonc
{
  "serverTime": 1755000000,
  "schemaVersion": 1,
  "feeds": [ /* Feed[]。レート降順、同率は未読数降順 */ ],
  "entries": [ /* Entry[]。上位フィードの未読記事 */ ],
  "pins": [ /* Pin[] */ ],
  "maxEntryId": 12345      // この時点でサーバが持つ最大 entries.id
}
```

`maxEntryId` は以降の差分取得のカーソルになる。

### `GET /api/entries`

バックグラウンドで残りの記事を引くための一括取得。

| 名前 | 既定値 | 説明 |
| --- | --- | --- |
| `sinceId` | 0 | この id より大きい記事を返す |
| `feedId` | — | 指定時はそのフィードに限定 |
| `unreadOnly` | true | 未読のみ（`id > read_seq` かつ手動未読を含む） |
| `limit` | 500 | 最大 1000 |

```jsonc
{
  "entries": [ /* Entry[]。id 昇順 */ ],
  "nextSinceId": 12800,    // 続きがある場合。無ければ null
  "hasMore": true
}
```

**ページングは必ず `sinceId` で行う。** オフセットは使わない（取得中に新着が入ると重複・欠落する）。

### `GET /api/sync`

複数端末間の差分同期。起動後の定期ポーリング（既定 5 分間隔）と、タブがフォアグラウンドに戻ったときに叩く。

| 名前 | 説明 |
| --- | --- |
| `entryCursor` | クライアントが持つ最大 entry id |
| `since` | 前回同期時刻（Unix 秒） |

```jsonc
{
  "serverTime": 1755000300,
  "feeds": [ /* since 以降に変化した Feed のみ。readSeq / unreadCount を含む */ ],
  "newEntries": [ /* entryCursor より大きい Entry[] */ ],
  "pins": [ /* since 以降に変化した Pin[] */ ],
  "deletedPinIds": [ 12, 34 ],
  "maxEntryId": 12900
}
```

クライアントは受け取った `readSeq` を `Math.max(local, remote)` でマージする。**上書きしない。**

## 書き込み

### `POST /api/read`

既読ウォーターマークの更新。outbox からまとめて送られる。

```jsonc
{
  "marks": [
    { "feedId": 1, "watermark": 12345 },
    { "feedId": 7, "watermark": 12290 }
  ]
}
```

サーバ側の処理は `UPDATE feeds SET read_seq = MAX(read_seq, ?) WHERE id = ?` を `batch()` で実行する。

**冪等。** 同じリクエストを何度送っても、順序が入れ替わっても結果は同じ。

レスポンス:

```jsonc
{
  "feeds": [ { "id": 1, "readSeq": 12345, "unreadCount": 0 } ]
}
```

### `POST /api/entries/:id/unread`

個別の記事を未読に戻す。`entry_states` に行を作る。ウォーターマークは動かさない。

### `DELETE /api/entries/:id/unread`

未読に戻した記事を既読に戻す（`entry_states` の行を削除）。

### `POST /api/pins`

```jsonc
{ "entryId": 123, "title": "...", "url": "https://..." }
```

`title` と `url` は必須。記事が保持期間を過ぎて削除されてもピンが生き残るよう非正規化して保存する。

同一 URL への重複追加は `INSERT OR REPLACE` で吸収する（冪等）。

### `DELETE /api/pins/:id`

## フィード管理

### `POST /api/feeds`

```jsonc
{ "url": "https://example.com/", "rate": 3, "folder": "tech" }
```

`url` はサイト URL でもフィード URL でもよい。サイト URL の場合は `<link rel="alternate" type="application/rss+xml">` を探してフィード URL を発見する（`HTMLRewriter` を使う）。

登録後、**同期的に初回クロールを実行**してから返す。ユーザが登録直後に記事を読めるようにするため。

複数のフィードが見つかった場合は 300 相当を返し、候補を提示する。

```jsonc
{ "candidates": [ { "url": "...", "title": "..." } ] }
```

### `PATCH /api/feeds/:id`

`rate`、`folder`、`title`、`disabled` を更新する。`title` はフィードの提供する値を上書きするユーザ指定値。

### `DELETE /api/feeds/:id`

記事も CASCADE で削除される。ピンは残る。

### `POST /api/feeds/:id/fetch`

手動での即時クロール。`next_fetch_at` を無視して実行し、更新後の Feed と新着 Entry を返す。

### `POST /api/feeds/fetch-all`

全フィードの即時クロール。サブリクエスト上限があるため、内部で分割して処理し、進捗は返さない（完了時にまとめて返す）。フィード数が多い場合はタイムアウトの可能性があるので、クライアント側は `GET /api/sync` でのフォローアップを前提にする。

## OPML

### `GET /api/opml`

`Content-Type: text/x-opml` で購読リストを返す。フォルダは `<outline>` の入れ子で表現し、レートは `ratatoskr:rate` 属性として出力する（他のリーダーからは無視される）。

### `POST /api/opml`

`multipart/form-data` または `text/x-opml` の生ボディを受け付ける。

```jsonc
{
  "imported": 42,
  "skipped": 3,        // 既に購読済み
  "failed": [ { "url": "...", "reason": "..." } ]
}
```

インポート時に初回クロールは**しない**。`next_fetch_at = 0` を設定して通常の cron に拾わせる（大量登録で上限に当たるのを避けるため）。

## LDR API との差分

参考までに、livedoor Reader API から意図的に変えた点。

| LDR | Ratatoskr | 理由 |
| --- | --- | --- |
| `ApiKey` をフォームパラメータで送る | Cloudflare Access の JWT | 認証をアプリから追い出す |
| `POST /api/subs` で全件取得 | `GET /api/bootstrap` で記事本文まで一括 | 起動時のラウンドトリップを 1 回にする |
| `/api/unread` をフィード単位で都度呼ぶ | `GET /api/entries` で一括先落とし | 想定規模なら全件手元に置ける |
| `last_stored_on`（タイムスタンプ） | `watermark`（entry id） | 時刻は巻き戻りうる。採番 id なら単調性が保証される |
| `application/x-www-form-urlencoded` | JSON | 型定義を共有するため |
