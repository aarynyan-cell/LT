// 把官方 @anthropic-ai/sdk 打包成浏览器可直接 import 的单文件（public/vendor/anthropic-sdk.mjs）。
// 仅在升级 SDK 时需要运行：npm run build:sdk（产物已提交，平时运行无需构建）。
import { build } from 'esbuild';
await build({
  stdin: { contents: "export { default, Anthropic } from '@anthropic-ai/sdk';", resolveDir: process.cwd(), loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'eof',
  outfile: 'public/vendor/anthropic-sdk.mjs',
  logLevel: 'info',
});
