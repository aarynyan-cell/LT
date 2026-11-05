// E2E：用 Chromium 的假麦克风 + 脚本化的假 SpeechRecognition 复现"临时字幕被下一句直接顶掉（无定稿）"，验证不丢字、时间合理。
// 先 npm start，再 node tests/e2e/live-recognition.cjs
const { chromium } = require('playwright');
const B = 'http://127.0.0.1:8787/';
// 脚本化的假 SpeechRecognition：[秒, 事件类型, 文本]。type: i=临时(当前未定稿结果), f=定稿
const SCRIPT = [
  [0.5, 'i', 'In that case we do your'],
  [1.0, 'i', 'In that case we do your research you use the lps'],
  [2.5, 'i', 'It is better than what we said so'],                       // 引擎丢弃上一句（无定稿），直接换成下一句
  [3.0, 'i', 'It is better than what we said so here we are mostly synonymous'],
  [4.0, 'f', 'It is better than what we said so here we are mostly synonymous together'],
  [4.6, 'i', 'from here let us be similar activate the law'],              // 最后一句停止时仍未定稿
];
const init = `(() => {
  const SCRIPT = ${JSON.stringify(SCRIPT)};
  window.webkitSpeechRecognition = window.SpeechRecognition = class {
    constructor() { this.timers = []; this.results = []; this.n = 0; }
    start() {
      const t0 = performance.now();
      for (const [sec, type, text] of SCRIPT) this.timers.push(setTimeout(() => {
        const cur = { 0: { transcript: text }, isFinal: type === 'f', length: 1 };
        if (type === 'f') { this.results[this.n] = cur; this.n++; this.onresult?.({ resultIndex: this.n - 1, results: this.results }); }
        else { this.results[this.n] = cur; this.onresult?.({ resultIndex: this.n, results: this.results }); }
      }, sec * 1000));
    }
    stop() { this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 10); }
    abort() { this.stop(); }
  };
})();`;
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const c = await b.newContext({ viewport: { width: 1360, height: 860 }, permissions: ['microphone'] });
  await c.addInitScript(init);
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(B + '#/live');
  await p.evaluate(() => {}); // 确保已录音许可
  await p.click('button:has-text("开始上课")');
  await p.waitForSelector('.modal');
  await p.click('.modal button:has-text("我已获得许可，开始")');
  await p.waitForSelector('.stage .ln', { timeout: 10000 });
  await p.waitForTimeout(5600);
  const shown = await p.locator('.stage .ln .o').allTextContents();
  console.log('上课页显示的句子:', JSON.stringify(shown));
  await p.click('button:has-text("结束并归档")'); await p.waitForURL(/#\/lesson\//, { timeout: 15000 }); await p.waitForSelector('.cue');
  const rows = await p.locator('.cue').evaluateAll((els) => els.map((e) => ({ t: e.querySelector('.t').textContent, text: e.querySelector('.tx').textContent.replace('🚩', '') })));
  console.log('归档后的转录:'); rows.forEach((r) => console.log('  ', r.t, r.text));
  console.log('页面错误:', errs);
  await b.close();
})();
