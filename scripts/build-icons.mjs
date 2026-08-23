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

/** 何をどの大きさで書き出すか。maskable と monochrome は安全域の取り方が違う */
const TARGETS = [
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
    const svg = readFileSync(new URL(target.source, publicDir), 'utf-8');
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
