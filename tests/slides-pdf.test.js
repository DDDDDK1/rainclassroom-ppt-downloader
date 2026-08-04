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
