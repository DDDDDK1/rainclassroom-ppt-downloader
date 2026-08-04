# 前端合成 PDF（图片型课件）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将图片型课件（`type:'img'`）的下载从「打印页 + CDP / 手动另存为」完全替换为「前端 `fetch` 封面字节 → 手写 PDF 写入器合成单个 PDF → Blob 下载」，根治无法全自动与白页两个问题。

**Architecture:** 新增三个 `Logic` 纯函数（`sanitizeFilename` / `jpegDimensions` / `buildSlidesPdf`）放入 `src/logic.js`（可单测）；`src/app.js` 中新增拉取管线（`fetchSlideBytes` / `normalizeSlidePage` / `fetchSlidePages`）与编排函数 `exportSlidesPdf`，替换原 `Print` 模块（删除 `cdpAvailable`/`cdpPrintToPdf`），`downloadFiles` 的 img 分支改接新函数。封面字节经 `fetch(cover, {mode:'cors', credentials:'omit'})` 获取（已实测 CDN 允许跨域但拒绝带凭据）。

**Tech Stack:** 原生 ES2018（零新增依赖）；PDF 由手写写入器输出（Catalog → Pages → Page + Contents + DCTDecode 图像 XObject → xref）；测试用 `node:test`（现有 `tests/*.test.js` 同构）。

## Global Constraints

- 版本：用户脚本 `@version` 从 `1.1.0` 升到 `1.2.0`（`src/app.js` 头部 + 构建产物，`build.js` 不读 package.json，版本硬编码在 src/app.js）。
- 依赖：**禁止新增运行时依赖**（不引入 JSZip/pdfkit/任何库）；零 `@require`。
- 封面拉取必须用 `{ mode:'cors', credentials:'omit' }` —— `credentials:'include'` 会触发 CORS 拦截（实测 `TypeError: Failed to fetch`）。
- 页尺寸统一：以 `buildSlidesPdf(pages)` 的 `pages[0]` 为整份 PDF 的 `MediaBox`；尺寸不同的页按比例缩放居中（不拉伸）。
- 逐页失败隔离：`fetchSlidePages` 返回 `{ pages, failed }`，仅成功页进 `pages`；`failed === slideList.length` 时抛错。
- PDF 写入器 xref 偏移必须字节精确：**用 `Uint8Array` 拼接**（JPEG 含任意字节，禁止字符串拼接 JPEG），输出以 `%PDF-1.4\n` 开头、`%%EOF\n` 结尾。
- 兼容：`node --test` 单测全绿（现有 21 个 + 新增）；`npm run build` 通过；仓库 PUBLIC，合并/推送前用户确认。

---

### Task 1: Logic 纯函数 —— `sanitizeFilename` + `jpegDimensions`

**Files:**
- Modify: `src/logic.js`（在 return 前追加两个函数，并加入导出对象）
- Create: `tests/slides-pdf.test.js`

**Interfaces:**
- Produces:
  - `Logic.sanitizeFilename(name: any) → string`：过滤 `\ / : * ? " < > |` 为 `_`，去首尾空白，空值回退 `'courseware'`。
  - `Logic.jpegDimensions(bytes: Uint8Array) → {width:number, height:number}`：扫描 JPEG 段头取 SOF 宽高；非 JPEG 抛 `'非 JPEG 文件'`，未到 SOF 抛 `'未找到 JPEG SOF 段'`，SOF 截断抛 `'JPEG SOF 段截断'`。

- [ ] **Step 1: 写失败测试**

`tests/slides-pdf.test.js`：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/slides-pdf.test.js`
Expected: FAIL（`L.sanitizeFilename is not a function` / `L.jpegDimensions is not a function`）。

- [ ] **Step 3: 最小实现**

在 `src/logic.js` 的 `collectSelection` 之后、`return {` 之前追加：

```js
  // 文件名净化：过滤 Windows/跨平台非法字符（Task：前端合成 PDF）
  function sanitizeFilename(name) {
    const s = String(name || '').replace(/[\/\\:*?"<>|]/g, '_').trim();
    return s || 'courseware';
  }

  // 解析 JPEG SOF 帧头取宽高（封面为 JPEG 时直嵌 PDF，免解码）
  function jpegDimensions(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('非 JPEG 文件');
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xFF || marker === 0x00) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; } // 无长度段
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) { i += 2; continue; }
      const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof) {
        if (i + 9 > b.length) throw new Error('JPEG SOF 段截断');
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + len;
    }
    throw new Error('未找到 JPEG SOF 段');
  }
```

并把导出对象改为（在 `collectSelection,` 后追加两行）：

```js
    collectSelection,
    sanitizeFilename,
    jpegDimensions,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/slides-pdf.test.js`
Expected: 4 个测试全 PASS。

- [ ] **Step 5: 回归 + 提交**

Run: `npm test`（应仍 21 全绿 + 新增 4 个）。
Commit:
```bash
git add src/logic.js tests/slides-pdf.test.js
git commit -m "feat: Logic.sanitizeFilename / Logic.jpegDimensions 纯函数 + 单测"
```

---

### Task 2: Logic 纯函数 —— `buildSlidesPdf`

**Files:**
- Modify: `src/logic.js`（追加 `buildSlidesPdf` 并导出）
- Modify: `tests/slides-pdf.test.js`（追加测试）

**Interfaces:**
- Consumes: `makeJpeg()`（Task 1 测试辅助）。
- Produces: `Logic.buildSlidesPdf(pages: Array<{bytes:Uint8Array, width:number, height:number}>) → Uint8Array`。`pages` 为空抛 `'无可合成页面'`；`pages[0]` 缺宽高抛 `'页面尺寸无效'`。输出 PDF 每页 `MediaBox [0 0 pageW pageH]`（pageW/H 取 `pages[0]`）。

- [ ] **Step 1: 写失败测试**

在 `tests/slides-pdf.test.js` 末尾追加：

```js
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
  assert.ok(txt.endsWith('%%EOF'), '%%EOF 结尾');
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/slides-pdf.test.js`
Expected: `buildSlidesPdf` 相关 FAIL（function not defined）。

- [ ] **Step 3: 最小实现**

在 `src/logic.js` 的 `jpegDimensions` 之后、`return {` 之前追加：

```js
  // 手写极简 PDF 写入器：每页一张全幅 JPEG，页尺寸统一为 pages[0]
  function buildSlidesPdf(pages) {
    if (!Array.isArray(pages) || !pages.length) throw new Error('无可合成页面');
    const first = pages[0];
    if (!first || !first.width || !first.height) throw new Error('页面尺寸无效');
    const pageW = first.width;
    const pageH = first.height;

    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const xref = [];
    const pushStr = (s) => { const u = enc.encode(s); chunks.push(u); offset += u.length; };
    const pushBytes = (u) => { chunks.push(u); offset += u.length; };
    const markObj = () => xref.push(offset);
    const fmt = (n) => Math.round(n * 1000) / 1000;

    pushStr('%PDF-1.4\n');
    const n = pages.length;

    markObj(); // 1 Catalog
    pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    const kids = pages.map((_, p) => `${3 + p * 3} 0 R`).join(' ');
    markObj(); // 2 Pages
    pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

    pages.forEach((pg, p) => {
      const pageObj = 3 + p * 3, contentObj = pageObj + 1, imgObj = pageObj + 2;
      const iw = pg.width, ih = pg.height;
      const content = (iw === pageW && ih === pageH)
        ? `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q\n`
        : (() => {
            const s = fmt(Math.min(pageW / iw, pageH / ih));
            const dx = fmt((pageW - iw * s) / 2);
            const dy = fmt((pageH - ih * s) / 2);
            return `q ${s} 0 0 ${s} ${dx} ${dy} cm /Im0 Do Q\n`;
          })();
      const contentBytes = enc.encode(content);

      markObj(); // Page
      pushStr(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);

      markObj(); // Contents
      pushStr(`${contentObj} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      pushBytes(contentBytes);
      pushStr('\nendstream\nendobj\n');

      markObj(); // Image
      pushStr(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
      pushBytes(pg.bytes);
      pushStr('\nendstream\nendobj\n');
    });

    const xrefOffset = offset;
    let xrefStr = `xref\n0 ${xref.length + 1}\n0000000000 65535 f \n`;
    xref.forEach((off) => { xrefStr += `${String(off).padStart(10, '0')} 00000 n \n`; });
    pushStr(xrefStr);
    pushStr(`trailer\n<< /Size ${xref.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const total = chunks.reduce((s, u) => s + u.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const u of chunks) { out.set(u, o); o += u.length; }
    return out;
  }
```

并把导出对象改为（在 `jpegDimensions,` 后追加）：

```js
    jpegDimensions,
    buildSlidesPdf,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/slides-pdf.test.js`
Expected: 全部 PASS（含 Task 1 的 4 个 + 本任务 3 个）。

- [ ] **Step 5: 提交**

Commit:
```bash
git add src/logic.js tests/slides-pdf.test.js
git commit -m "feat: Logic.buildSlidesPdf 手写 PDF 写入器（JPEG 直嵌 + 页尺寸统一）+ 单测"
```

---

### Task 3: app.js —— 前端合成 PDF 下载管线替换 Print 模块

**Files:**
- Modify: `src/app.js:544-545`（`downloadFiles` 的 img 分支）
- Modify: `src/app.js:574-665`（整块替换 `Print` 模块为新的拉取 + 合成管线）

**Interfaces:**
- Consumes: `Logic.jpegDimensions` / `Logic.buildSlidesPdf` / `Logic.sanitizeFilename`（Task 1/2）；`Api.fetchLeafInfo/fetchReview/fetchPpt`、`uvIdFromCookie`、`triggerDownload`、`sleep`、`fetchJson` 的 AbortController 超时模式（均在 app.js 内已有）。
- Produces:
  - `fetchSlideBytes(cover: string) → Blob`：CORS fetch（`credentials:'omit'`）+ 20s 超时 + 重试一次。
  - `normalizeSlidePage(blob: Blob) → {bytes:Uint8Array, width, height}`：JPEG 直取；非 JPEG 经 Image+canvas → `toBlob('image/jpeg', 0.92)`。
  - `fetchSlidePages(slideList: Array, onProgress?: (done,total)=>void) → {pages, failed}`：并发上限 5，逐页失败隔离。
  - `exportSlidesPdf({classroomId, leafId, name}, onProgress?) → Promise<number>`：返回跳过的失败页数；全失败抛错。

- [ ] **Step 1: 替换 `Print` 模块**

将 `src/app.js:574-665`（注释「打印模块（图片流 → PDF）…」到 `};` 前的整个 `Print` 对象）整体替换为：

```js
  // ===== 图片流 → 前端合成 PDF（完全替换旧打印页/CDP）：fetch 封面 → 手写 PDF → Blob 下载 =====

  function uvIdFromCookie() {
    const m = document.cookie.match(/(?:^|;\s*)uv_id=([^;]+)/);
    return m ? m[1] : '';
  }

  // 拉取单页封面字节。关键：credentials:'omit'（CDN 允许跨域但拒绝带凭据）；20s 超时 + 重试一次
  async function fetchSlideBytes(cover) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(cover, { mode: 'cors', credentials: 'omit', signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.blob();
      } catch (err) {
        lastErr = err && err.name === 'AbortError' ? new Error('拉取超时') : err;
        if (attempt === 0) await sleep(1000);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // 归一化为可直接嵌入 PDF 的 JPEG 字节 + 尺寸：JPEG 直取（SOF 解析），其余经 canvas 转 JPEG
  async function normalizeSlidePage(blob) {
    if (blob.type === 'image/jpeg') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dim = Logic.jpegDimensions(bytes);
      return { bytes, width: dim.width, height: dim.height };
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('图片解码失败'));
        im.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const jpeg = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 编码失败'))), 'image/jpeg', 0.92);
      });
      return { bytes: new Uint8Array(await jpeg.arrayBuffer()), width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 并发拉取全部页面（上限 5），逐页失败隔离；返回 { pages, failed }
  async function fetchSlidePages(slideList, onProgress) {
    const pages = [];
    let failed = 0;
    let done = 0;
    let next = 0;
    const total = slideList.length;
    const limit = 5;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= total) return;
        try {
          pages.push(await normalizeSlidePage(await fetchSlideBytes(slideList[i].cover)));
        } catch (err) {
          failed++;
          console.warn('[雨课堂PPT下载器] 第 ' + (i + 1) + '/' + total + ' 页拉取失败：' + (err.message || err));
        }
        done++;
        if (onProgress) onProgress(done, total);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, total) }, () => worker()));
    if (!pages.length) throw new Error('全部 ' + total + ' 页拉取失败');
    return { pages, failed };
  }

  // 编排：API 懒加载链 → 拉取页面 → 合成 PDF → Blob 下载；返回跳过的失败页数
  async function exportSlidesPdf({ classroomId, leafId, name }, onProgress) {
    const leafInfo = await Api.fetchLeafInfo(classroomId, leafId, uvIdFromCookie());
    const review = await Api.fetchReview(leafInfo.courseware_id);
    const presentationId = review.timelineList[0].presentationId;
    const slideList = await Api.fetchPpt(leafInfo.courseware_id, presentationId);
    if (!slideList || !slideList.length) throw new Error('课件无分片图片');
    const { pages, failed } = await fetchSlidePages(slideList, onProgress);
    const pdf = Logic.buildSlidesPdf(pages);
    const blob = new Blob([pdf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    await triggerDownload(url, Logic.sanitizeFilename(name) + '.pdf');
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return failed;
  }
```

- [ ] **Step 2: 改接 `downloadFiles` 的 img 分支**

将 `src/app.js:544-552`（try 块内从 `if (r.type === 'img') {` 到 `if (mark) mark(i, '✓', '#2e8b57');`）整体替换为：

```js
        if (r.type === 'img') {
          const skipped = await exportSlidesPdf(
            { classroomId: f.classroomId, leafId: r.resourceId, name: r.name },
            (done, total) => { if (mark) mark(i, '拉取图片 ' + done + '/' + total, '#08f'); }
          );
          ok++;
          if (mark) mark(i, skipped > 0 ? '✓（' + skipped + ' 页失败）' : '✓', '#2e8b57');
        } else if (r.url) {
          await triggerDownload(r.url, r.name);
          ok++;
          if (mark) mark(i, '✓', '#2e8b57');
        } else {
          throw new Error('无下载地址');
        }
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: exit 0，`rainclassroom-ppt-downloader.user.js` 重新生成，且不再包含 `cdpPrintToPdf` / `win.print` / `/web/print` / `rain_print` 字样（`grep -c "cdpPrintToPdf\|win.print\|/web/print\|rain_print" rainclassroom-ppt-downloader.user.js` 应为 0）。

- [ ] **Step 4: 回归 + 提交**

Run: `npm test`（现有 + 新增应全绿）。
Commit:
```bash
git add src/app.js
git commit -m "feat: 图片型课件改前端合成 PDF（fetch 封面 + buildSlidesPdf），删除打印页/CDP 路径"
```

---

### Task 4: 版本 1.2.0 + README + 产物入库 + E2E 验证

**Files:**
- Modify: `src/app.js` 头部 `@version 1.1.0` → `1.2.0`
- Modify: `README.md`（图片流下载描述、删 CDP 小节）
- Modify: `rainclassroom-ppt-downloader.user.js`（构建产物，强制跟踪）

- [ ] **Step 1: 版本号**

`src/app.js` 第 4 行 `// @version      1.1.0` → `// @version      1.2.0`。

- [ ] **Step 2: README 更新**

`README.md`：
1. 第 11 行「直链下载」条目末尾：`导出统一走打印 PDF` → `图片流导出走前端合成 PDF（见下）`。
2. 第 12-14 行「图片流课件 → 打印导出 PDF」条目整体替换为：

```markdown
- **图片流课件 → 前端合成 PDF**：长江雨课堂的课堂 PPT 多为分片图片流（无原始文件），脚本逐页拉取完整图片字节，在前端合成单个 PDF 文件并自动下载：
  - 逐页并发拉取、逐页等待完整加载（无固定计时赌渲染），不会出现空白页；
  - 不依赖 Chrome 调试端口，无需手动「另存为」，无弹窗。
```

3. 删除第 39-47 行「### CDP 全自动导出（可选）」整个小节。
4. 第 68-69 行「已知限制」两条替换为：

```markdown
- **图片流课件无法下载源文件**：长江雨课堂的课堂 PPT 只有分片图片、无原始 PPT/PDF 文件，脚本将各页图片前端合成为单个 PDF（每页一张原图，页尺寸统一），无法还原为可编辑的 PPT。
```

- [ ] **Step 3: 全量单测 + 构建 + 产物入库**

Run: `npm test`（应 21 旧 + 8 新全绿）→ `npm run build` → `head -5 rainclassroom-ppt-downloader.user.js`（`@version 1.2.0`）。
```bash
git add -f rainclassroom-ppt-downloader.user.js src/app.js README.md
git commit -m "release: @version 1.2.0 + README 同步前端合成 PDF 描述，产物入库"
```

- [ ] **Step 4: Playwright E2E 验证（仓库惯例，复用雨课堂登录态）**

在 `https://changjiang.yuketang.cn/v2/web/index` 注入构建产物（GM shim：`GM_getValue/GM_setValue` 存 localStorage `GM_<key>` 前缀；`page.addScriptTag({path})`），勾选一门含图片型课件的课下载，拦截下载事件拿到 `.pdf`，然后用本机 `pypdfium2`（`python -c "import pypdfium2"`）渲染首页并校验：
- PDF 文件非空、`%PDF-` 头正确；
- 页数 = 成功页数（≥ slideCount − 失败页，可从下载行状态/控制台确认失败页数）；
- 首页渲染为 PNG 后非空白像素占比 > 1%（直接证明无白页）。
预期：以上全部通过。

- [ ] **Step 5: 台账记录**

在 `.superpowers/sdd/2026-08-03-rainclassroom-ppt-downloader/progress.md` 末尾追加：

```markdown
Task 12 (frontend-slides-pdf, 2026-08-04): 图片型课件下载改为前端合成单个 PDF——fetch 封面字节（CORS, credentials:omit）+ Logic.buildSlidesPdf 手写 PDF 写入器（JPEG 直嵌、页尺寸统一）；删除打印页/CDP 路径，根治手动另存为与白页。单测 29 绿（21 旧 + 8 新）；Playwright 真实下载校验 PDF 页数 + pypdfium2 首页非空白；@version 1.2.0。
```

- [ ] **Step 6: 合并前自检 + 合并**

Run: `npm test`、`npm run build`、`git status`（干净）。随后用 `superpowers:finishing-a-development-branch` 合并回 master（仓库 PUBLIC，合并/推送前用户确认）。
