// tests/slides-pdf.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

// 构造 SOF 宽=8 高=6 的最小 JPEG：SOI + APP0(len16) + SOF0(len17)
function makeJpeg() {
  const b = [0xFF, 0xD8];
  b.push(0xFF, 0xE0, 0x00, 0x10, ...new Array(16).fill(0));
  b.push(0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x06, 0x00, 0x08, ...new Array(12).fill(0));
  return new Uint8Array(b);
}

test('sanitizeFilename 过滤非法字符', () => {
  assert.equal(L.sanitizeFilename('a/b\\c:d*e?f"g<h>i|'), 'a_b_c_d_e_f_g_h_i_');
  assert.equal(L.sanitizeFilename('第1章 课件'), '第1章 课件');
  assert.equal(L.sanitizeFilename(''), 'courseware');
  assert.equal(L.sanitizeFilename(null), 'courseware');
});

function dec(pdf, at) {
  return new TextDecoder().decode(pdf.subarray(at, at + 20));
}

test('jpegDimensions 解析 SOF 宽高', () => {
  assert.deepEqual(L.jpegDimensions(makeJpeg()), { width: 8, height: 6 });
});

test('jpegDimensions 非 JPEG → 抛错', () => {
  assert.throws(() => L.jpegDimensions(new Uint8Array([0x89, 0x50, 0x4E, 0x47])), /非 JPEG/);
});

test('jpegDimensions 截断（未到 SOF）→ 抛错', () => {
  assert.throws(() => L.jpegDimensions(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), /未找到 JPEG SOF/);
});

function xrefOffsets(pdf) {
  const dec = new TextDecoder();
  const tail = dec.decode(pdf.subarray(Math.max(0, pdf.length - 120)));
  const m = tail.match(/startxref\s+(\d+)\s+%%EOF/);
  assert.ok(m, '应含 startxref/%%EOF');
  const xrefAt = Number(m[1]);
  const head = dec.decode(pdf.subarray(xrefAt, xrefAt + 120));
  assert.ok(head.startsWith('xref'), 'xref 表存在');
  const cm = head.match(/^xref\n0 (\d+)\n/);
  assert.ok(cm, 'xref 头正确');
  const count = Number(cm[1]);
  const entries = [];
  const body = dec.decode(pdf.subarray(xrefAt, xrefAt + 30 + count * 20));
  const er = /(\d{10}) (\d{5}) ([nf])/g;
  let mm;
  while ((mm = er.exec(body))) entries.push(Number(mm[1]));
  assert.equal(entries.length, count, 'xref 条目数 = Count');
  return entries;
}

test('buildSlidesPdf 单页结构正确', () => {
  const img = makeJpeg();
  const pdf = L.buildSlidesPdf([{ bytes: img, width: 8, height: 6 }]);
  const txt = new TextDecoder().decode(pdf);
  assert.ok(txt.startsWith('%PDF-1.4'), 'PDF 头');
  assert.ok(txt.endsWith('%%EOF\n'), '%%EOF 结尾');
  assert.match(txt, /\/Count 1/);
  assert.match(txt, /\/Filter \/DCTDecode/);
  assert.match(txt, /\/MediaBox \[0 0 8 6\]/);
  const entries = xrefOffsets(pdf);
  for (let k = 1; k < entries.length; k++) {
    assert.ok(dec(pdf, entries[k]).startsWith(`${k} 0 obj`), `xref[${k}] 指向正确对象`);
  }
});

test('buildSlidesPdf 两页不同尺寸 → 页尺寸统一为第一页', () => {
  const img = makeJpeg();
  const pdf = L.buildSlidesPdf([
    { bytes: img, width: 8, height: 6 },
    { bytes: img, width: 16, height: 12 }
  ]);
  const txt = new TextDecoder().decode(pdf);
  assert.match(txt, /\/Count 2/);
  const boxes = txt.match(/\/MediaBox \[0 0 8 6\]/g);
  assert.ok(boxes && boxes.length === 2, '两页 MediaBox 均统一为 8x6');
  assert.match(txt, /\/Width 16/);
  assert.match(txt, /q 0\.5 0 0 0\.5 0 0 cm \/Im0 Do Q/); // 16x12 → 0.5 缩放居中
});

test('buildSlidesPdf 空 pages → 抛错', () => {
  assert.throws(() => L.buildSlidesPdf([]), /无可合成页面/);
});
