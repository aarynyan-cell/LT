// 迷你 ZIP 读取 + docx 段落提取：无需 JSZip/mammoth，依赖 DecompressionStream('deflate-raw')（浏览器与 Node ≥18 均有）。

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 读取 zip 中某个文件，返回 Uint8Array；找不到返回 null */
export async function unzipEntry(buf, wanted) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 从尾部找 End Of Central Directory
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (u32(v, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx 文件');
  const count = u16(v, eocd + 10);
  let p = u32(v, eocd + 16);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(v, p) !== 0x02014b50) break;
    const method = u16(v, p + 10);
    const csize = u32(v, p + 20);
    const nlen = u16(v, p + 28), elen = u16(v, p + 30), clen = u16(v, p + 32);
    const lho = u32(v, p + 42);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    if (name === wanted) {
      const lnlen = u16(v, lho + 26), lelen = u16(v, lho + 28);
      const data = u8.subarray(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`不支持的压缩方式 ${method}`);
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

const decodeXml = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** .docx → 段落文本数组（保留段落边界；空段落丢弃） */
export async function readDocxParagraphs(buf) {
  const data = await unzipEntry(buf, 'word/document.xml');
  if (!data) throw new Error('docx 中没有 word/document.xml');
  const xml = new TextDecoder('utf-8').decode(data);
  const paras = [];
  for (const pm of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    let t = '';
    for (const tm of pm[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      t += tm[1] !== undefined ? decodeXml(tm[1]) : ' ';
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (t) paras.push(t);
  }
  return paras;
}
