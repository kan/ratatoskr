/**
 * 音声の位置の表記（issue #46）。要約の目次（Worker）と文字起こしの表示（画面）で揃える。
 * 1 時間を超えれば `1:05:09`、超えなければ `5:32`
 */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
