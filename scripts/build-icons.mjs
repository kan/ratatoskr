import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

/**
 * SVG から PNG のアイコンを書き出す。
 *
 * **アイコンの正本は SVG。** PNG は手で描き直さず、ここから起こす。
 * ずれると「ホーム画面のアイコンだけ古い図柄」という気付きにくい形で残る。
 *
 * 描くのは Playwright の Chromium（E2E で既に入っている）。ImageMagick のような
 * 外部の道具を増やさずに済み、ブラウザが実際に描くのと同じ絵になる。
 *
 * 使い方: pnpm icons
 */

/**
 * 未読が無いときの色。RSS マークだけを薄いグレーに落とす。
 * 明るいテーマでも暗いテーマでも沈んで見える中間の明度を選んである
 */
const MUTED = { '#FF6600': '#A1A1AA' };

/** 何をどの大きさで書き出すか。maskable と monochrome は安全域の取り方が違う */
const TARGETS = [
  // タブのアイコン。SVG を当てにできないブラウザ（Safari）向けの控え。
  // 未読の有無で差し替えるので 2 枚要る（web/src/lib/favicon.ts）
  // 透明を残す。図柄は透過背景で、明暗どちらのタブでも沈まないようにしてある
  // （web/index.html）。白で焼き込むと暗いテーマで白い四角になる
  { source: 'favicon.svg', out: 'favicon.png', size: 32, transparent: true },
  // 未読が無いときのタブのアイコン（issue #7）。**同じ図柄の色違いなので起こす。**
  // 手で複製すると、マークを直したときに片方だけ古いまま残る（未読が無いときにしか
  // 出ないので、手元で気付く機会がほぼ無い）
  {
    source: 'favicon.svg',
    out: 'favicon-muted.png',
    size: 32,
    transparent: true,
    recolor: MUTED,
    svgOut: 'favicon-muted.svg',
  },
  { source: 'icon-brand.svg', out: 'icon-192.png', size: 192 },
  { source: 'icon-brand.svg', out: 'icon-512.png', size: 512 },
  { source: 'icon-brand.svg', out: 'apple-touch-icon.png', size: 180 },
  { source: 'icon-maskable.svg', out: 'icon-maskable-192.png', size: 192 },
  { source: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  // 透明を残す。ランチャーはアルファだけを見て塗り直す
  { source: 'icon-monochrome.svg', out: 'icon-monochrome-512.png', size: 512, transparent: true },
];

const publicDir = new URL('../web/public/', import.meta.url);

const browser = await chromium.launch();
try {
  for (const target of TARGETS) {
    let svg = readFileSync(new URL(target.source, publicDir), 'utf-8');
    for (const [from, to] of Object.entries(target.recolor ?? {})) svg = svg.replaceAll(from, to);
    // 色違いは SVG も書き出す。タブが読むのはこちらで、PNG は控え
    if (target.svgOut !== undefined) writeFileSync(new URL(target.svgOut, publicDir), svg);
    const page = await browser.newPage({
      viewport: { width: target.size, height: target.size },
      // 端末の画素密度は関係ない。指定した大きさちょうどで書き出す
      deviceScaleFactor: 1,
    });
    // svg を等倍で敷き詰める。body の余白が入ると 1px ずれる
    await page.setContent(
      `<style>html,body{margin:0;padding:0}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: target.transparent === true });
    writeFileSync(new URL(target.out, publicDir), png);
    await page.close();
    console.log(`${target.out} (${target.size}px) ← ${target.source}`);
  }
} finally {
  await browser.close();
}
