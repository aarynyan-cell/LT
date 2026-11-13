// 插件 E2E 用的静态服务：测试页 + 60 秒静音 WAV（支持 Range，才能拖动时间）+ 由测试页的字幕表生成的 WebVTT。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { asrWords, json3 } = require('./ext-data.cjs');
const hits = { timedtext: 0, watch: 0 }; // 统计请求次数（断言"第二次打开不再取字幕"）

const CUES = [
  [0.0, 2.0, 'Salut, comment ça va ?'], [2.5, 4.5, 'Je ne sais pas ce que vous voulez.'], [5.0, 7.0, "C'est trop tard, il faut partir."],
  [7.5, 9.5, 'Où est-ce que tu vas ?'], [10, 12, 'Je vais chez moi, merci.'], [12.5, 14.5, "Qu'est-ce que vous faites ici ?"],
  [15, 17, 'On doit parler, tous les deux.'], [17.5, 19.5, "Non, c'est impossible."], [20, 22, 'Il est très tard maintenant.'],
  [22.5, 24.5, 'Alors, à demain peut-être.'], [25, 27, 'Oui, à demain, mon ami.'], [27.5, 29.5, 'Bonne nuit à tous.'], [30, 32, '你到底想要什么？'],
];
const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(3).padStart(6, '0'); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x}`; };
const VTT = 'WEBVTT\n\n' + CUES.map(([a, b, t], i) => `${i + 1}\n${ts(a)} --> ${ts(b)}\n${t}\n`).join('\n');

function wav(seconds = 60, rate = 8000) {
  const n = seconds * rate, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const WAV = wav();
function speechWav(seconds = 30, rate = 16000) {
  const n = seconds * rate, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  const bursts = [[1.0, 3.4], [6.0, 9.2], [14.0, 16.5]];
  for (let i = 0; i < n; i++) {
    const t = i / rate, on = bursts.some(([a, c]) => t >= a && t < c);
    const v = on ? 0.28 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t)) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 3.5 * t)) : 0;
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return b;
}
const SPEECH = speechWav();
function serveBuf(req, res, buf, type) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { const a = +m[1], e = m[2] ? +m[2] : buf.length - 1; res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${e}/${buf.length}`, 'content-length': e - a + 1 }); return res.end(buf.subarray(a, e + 1)); }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': buf.length }); return res.end(buf);
}

function start(port = 8799) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // 仿 YouTube：/watch?v=… 返回测试页（页面里内嵌 captionTracks，与真实页面 HTML 里的位置一样）；/timedtext 返回字幕数据
    const origin = `http://${req.headers.host}`;
    const tracks = hits.noTracks ? [] : [{ baseUrl: `${origin}/timedtext?v=TESTVID12345&lang=fr&kind=asr`, name: { simpleText: 'French (auto-generated)' }, languageCode: 'fr', kind: 'asr' }];
    if (u.pathname === '/watch') {
      hits.watch++;
      const html = fs.readFileSync(path.join(__dirname, 'ext-pages/page.html'), 'utf8').replace('__YT_DATA__', JSON.stringify({ captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks, audioTracks: [] } } }));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (u.pathname === '/timedtext') {
      hits.timedtext++;
      if (u.searchParams.get('variant') === 'empty' || process.env.TIMEDTEXT_EMPTY) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(''); } // YouTube 有时对非播放器请求返回空内容
      if (u.searchParams.get('fmt') === 'json3') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(json3())); }
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end('<?xml version="1.0"?><transcript>' + asrWords().map((x) => `<text start="${x.t}" dur="0.3">${x.w.replace(/'/g, '&amp;#39;')}</text>`).join('') + '</transcript>');
    }
    if (u.pathname === '/yt-words.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(asrWords())); }
    if (u.pathname === '/__hits') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(hits)); }
    if (u.pathname === '/page.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'ext-pages/page.html'), 'utf8').replace('__YT_DATA__', 'null')); }
    if (u.pathname === '/fr.vtt') { res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' }); return res.end(VTT); }
    if (u.pathname === '/speech.wav') return serveBuf(req, res, SPEECH, 'audio/wav');
    if (u.pathname === '/silence.wav') {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const a = +m[1], b = m[2] ? +m[2] : WAV.length - 1;
        res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${WAV.length}`, 'content-length': b - a + 1 });
        return res.end(WAV.subarray(a, b + 1));
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': WAV.length });
      return res.end(WAV);
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}
module.exports = { start, CUES, hits };
