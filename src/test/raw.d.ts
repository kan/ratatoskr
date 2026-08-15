// フィクスチャの XML は Vite の ?raw で文字列として読み込む。
// Workers 上では fs が使えないので、テストからファイルを直接開かない
declare module '*?raw' {
  const content: string;
  export default content;
}
