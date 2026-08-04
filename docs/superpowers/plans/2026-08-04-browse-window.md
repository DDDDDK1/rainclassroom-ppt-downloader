# 二级浏览窗口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把主按钮改为打开「二级浏览窗口」（统一中心），可浏览已扫描的全部课程/文件、行高亮选中并下载、随时清空缓存；扫描移入窗口内。

**Architecture:** 主按钮点击 → `openBrowse()` → 第一级课程列表（读缓存）→ 点击课程下钻第二级文件列表；两级均有复选框（勾选整行高亮 + 左侧色条）与操作栏（全选/下载选中/清空缓存/关闭）。下载统一走新增 `downloadFiles(files, mark)` 核心（复用 `Print.exportPdf` / `triggerDownload`）；第一级课程选择经 `logic.js` 新增纯函数 `collectSelection` 展开为文件。扫描复用现有 `runScan()`，完成后刷新列表 + 会话级「新」徽标 + 横幅。

**Tech Stack:** 原生 JS IIFE 用户脚本；`node:test` 单测（logic.js）；Playwright MCP 手动 UI 验证。构建 `node build.js`。

## Global Constraints

- 缓存结构 `version: 1` 不变，旧缓存兼容（`rcppt_cache_v1`）
- 用户脚本 `@version` 1.0.0 → **1.1.0**；package.json 同步 1.1.0
- 产物 `rainclassroom-ppt-downloader.user.js` 在 .gitignore，改动后 `git add -f` 强制跟踪
- 全部改动在 `feature/browse-window` 分支；每任务独立提交
- UI 无单测（app.js IIFE 未导出，与仓库现状一致），验证走 Playwright 手动 + `npm test` 逻辑单测
- 文案中文，与现有 UI 一致；动态课件名一律 `textContent`（防注入）
- 模型纪律：实现者/审查者统一 haiku（交接文档 §6）；仓库 PUBLIC，push 需用户确认

---

### Task 1: logic.js — `collectSelection` 纯函数 + 单测（TDD）

**Files:**
- Create: `tests/selection.test.js`
- Modify: `src/logic.js`（新增 `collectSelection` 并在 return 对象导出）

**Interfaces:**
- Produces: `Logic.collectSelection(cache, courseRefs, resourceRefs)`
  - `cache`: `{ version, courses: [{courseId, classroomId, courseName, className, resources: [{resourceId, name, type, url, scanTime}]}] }`
  - `courseRefs`: `[{courseId, classroomId}]` 或 null/[]（第一级课程选择）
  - `resourceRefs`: `[{courseId, classroomId, resourceId}]` 或 null/[]（第二级文件选择）
  - 返回: `[{ courseId, classroomId, courseName, className, resource }]`，按 `courseId:classroomId:resourceId` 去重合并

- [ ] **Step 1: 写失败测试** `tests/selection.test.js`

```js
// tests/selection.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

function makeCache() {
  return {
    version: 1,
    courses: [
      {
        courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
        resources: [
          { resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1' },
          { resourceId: 'r2', name: '第2章.pdf', type: 'pdf', url: 'u2' }
        ],
        scanTime: 1
      },
      {
        courseId: 'c1', classroomId: 'k2', className: '高数B班', courseName: '高数',
        resources: [{ resourceId: 'r3', name: '第3章.pdf', type: 'pdf', url: 'u3' }],
        scanTime: 1
      }
    ]
  };
}

test('collectSelection 只传 courseRefs → 展开该课全部资源', () => {
  const files = L.collectSelection(makeCache(), [{ courseId: 'c1', classroomId: 'k1' }], null);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.resource.resourceId).sort(), ['r1', 'r2']);
  assert.equal(files[0].courseName, '高数');
  assert.equal(files[0].className, '高数A班');
});

test('collectSelection 只传 resourceRefs → 返回具体文件', () => {
  const files = L.collectSelection(makeCache(), null, [{ courseId: 'c1', classroomId: 'k2', resourceId: 'r3' }]);
  assert.equal(files.length, 1);
  assert.equal(files[0].resource.resourceId, 'r3');
});

test('collectSelection 两级混合 → 去重合并（同一文件不重复）', () => {
  const files = L.collectSelection(
    makeCache(),
    [{ courseId: 'c1', classroomId: 'k1' }],
    [{ courseId: 'c1', classroomId: 'k1', resourceId: 'r1' }]
  );
  assert.equal(files.length, 2); // r1 在课程展开与具体引用中只出现一次
});

test('collectSelection 未知引用 → 忽略不报错', () => {
  const files = L.collectSelection(
    makeCache(),
    [{ courseId: 'nope', classroomId: 'x' }],
    [{ courseId: 'c1', classroomId: 'k1', resourceId: 'no-such' }]
  );
  assert.equal(files.length, 0);
});

test('collectSelection 空输入 → 空数组', () => {
  assert.deepEqual(L.collectSelection(makeCache(), null, null), []);
  assert.deepEqual(L.collectSelection(makeCache(), [], []), []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL — `TypeError: L.collectSelection is not a function`

- [ ] **Step 3: 实现** — 在 `src/logic.js` 的 `diffCourses` 之后、`return {` 之前新增：

```js
  // 浏览窗口：把课程级选择展开为具体文件、与文件级选择合并去重
  function collectSelection(cache, courseRefs, resourceRefs) {
    const result = [];
    const seen = new Set();
    const push = (course, resource) => {
      const key = `${course.courseId}:${course.classroomId}:${resource.resourceId}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({
        courseId: course.courseId,
        classroomId: course.classroomId,
        courseName: course.courseName,
        className: course.className,
        resource
      });
    };
    (courseRefs || []).forEach((ref) => {
      const course = cache.courses.find(
        (c) => c.courseId === ref.courseId && c.classroomId === ref.classroomId
      );
      if (!course) return;
      (course.resources || []).forEach((r) => push(course, r));
    });
    (resourceRefs || []).forEach((ref) => {
      const course = cache.courses.find(
        (c) => c.courseId === ref.courseId && c.classroomId === ref.classroomId
      );
      if (!course) return;
      const resource = (course.resources || []).find((r) => r.resourceId === ref.resourceId);
      if (resource) push(course, resource);
    });
    return result;
  }
```

在 `return {` 对象中加入 `collectSelection`（放在 `diffCourses` 后）：

```js
    diffCourses,
    collectSelection,
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS — 16 旧 + 5 新 = 21 全绿

- [ ] **Step 5: Commit**

```bash
git add src/logic.js tests/selection.test.js
git commit -m "feat: collectSelection 课程/文件选择合并纯函数 + 单测"
```

---

### Task 2: app.js — 下载链路重构（`Print.exportPdf` 描述符签名 + `downloadFiles` 核心）

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `Logic`（来自 `window.RCLogic`，Task 1 新增的 `collectSelection` 供 Task 3 使用）
- Produces: `downloadFiles(files, mark)` — 供 Task 3 两级下载复用
  - `files`: `[{ courseId, classroomId, resource: { resourceId, name, type, url } }]`（courseId 可省略）
  - `mark`: 可选 `(index, text, color) => void`，逐文件状态回调
  - 返回: `Promise<{ ok, fail }>`
- Produces: `Print.exportPdf({ classroomId, leafId, name })` — 签名由 `(row)` 改为描述符对象

- [ ] **Step 1: 改 `Print.exportPdf` 签名为描述符**

在 `src/app.js` 找到 `async exportPdf(row) {`（约 431 行），改为：

```js
    async exportPdf({ classroomId, leafId, name }) {
```

并删除函数体内前三行取 dataset 的代码（原 `const classroomId = row.dataset.classroomId;` / `const leafId = row.dataset.leafId;` / `const name = row.dataset.name;`），只保留 `// 懒加载：leaf → courseware_id → presentationId → slideList` 及其后逻辑。

- [ ] **Step 2: 新增 `downloadFiles` 统一下载核心**

在 `triggerDownload` 函数之后、`markRow` 之前新增：

```js
  // 统一下载核心（Task：浏览窗口两级复用）：files 来自 collectSelection 或行 dataset
  async function downloadFiles(files, mark) {
    let ok = 0, fail = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const r = f.resource;
      if (mark) mark(i, '下载中…', '#08f');
      try {
        if (r.type === 'img') {
          await Print.exportPdf({ classroomId: f.classroomId, leafId: r.resourceId, name: r.name });
        } else if (r.url) {
          await triggerDownload(r.url, r.name);
        } else {
          throw new Error('无下载地址');
        }
        ok++;
        if (mark) mark(i, '✓', '#2e8b57');
      } catch (e) {
        fail++;
        console.warn('[雨课堂PPT下载器] 下载失败：' + r.name + ' — ' + e.message);
        if (mark) mark(i, '失败', '#c00');
      }
      await sleep(800);
    }
    return { ok, fail };
  }
```

- [ ] **Step 3: 重写旧面板 `onDownloadClick` 走 `downloadFiles`（行为保持）**

把 `async function onDownloadClick(panel) {` 的函数体替换为：

```js
  async function onDownloadClick(panel) {
    const rows = Array.from(panel.querySelectorAll('.rcppt-row')).filter((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      return cb && cb.checked && !cb.disabled;
    });
    const files = rows.map((row) => ({
      classroomId: row.dataset.classroomId,
      resource: {
        resourceId: row.dataset.leafId,
        name: row.dataset.name,
        type: row.dataset.type,
        url: row.dataset.url
      }
    }));
    await downloadFiles(files, (i, text, color) => markRow(rows[i], text, color));
  }
```

- [ ] **Step 4: 验证行为保持**

Run: `npm test`（逻辑未动，16 旧 + 5 新 = 21 绿）
Expected: PASS。代码自审：`onDownloadClick` 的 `files[i]` 与 `rows[i]` 一一对应（同一顺序构建），行状态标记行为与旧实现一致。

- [ ] **Step 5: Commit**

```bash
git add src/app.js
git commit -m "refactor: 下载链路统一为 downloadFiles 核心，Print.exportPdf 改描述符签名"
```

---

### Task 3: app.js — 浏览窗口（统一中心 UI）

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `downloadFiles(files, mark)`（Task 2）、`Logic.collectSelection`（Task 1）、`runScan()`（现有，返回 diff 并合并缓存）、`Store`、`Print`、`markRow`、`triggerDownload`
- Produces: `openBrowse()` — 主按钮点击入口（Task 4 的 ensureButton 绑定它）

- [ ] **Step 1: 新增 CSS（选中效果等）**

在 `ensureStyles()` 的模板字符串末尾（`.rcppt-badge.img{background:#999}` 后）追加：

```css
      .rcppt-row.selected{background:#e8f3ff;box-shadow:inset 3px 0 0 #0088ff}
      .rcppt-badge.new{background:#f5a623}
      .rcppt-browse-top{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:600}
      .rcppt-browse-top .rcppt-scan{margin-left:auto;font-weight:400}
      .rcppt-empty{text-align:center;padding:28px 0;color:#888}
      .rcppt-notice{padding:8px 10px;background:#fff8e1;border:1px solid #ffd54f;border-radius:6px;margin-bottom:8px;color:#6d4c00}
      .rcppt-count{color:#999;font-size:12px}
      .rcppt-status-line{padding:4px 0;font-size:13px}
      .rcppt-course{cursor:pointer}
```

- [ ] **Step 2: `ensureButton` 绑定 `openBrowse`；新增浏览窗口状态**

把 `ensureButton` 的 `btn.addEventListener('click', onScanClick);` 改为 `btn.addEventListener('click', openBrowse);`

并在 `ensureButton` 之前新增状态与 key 辅助：

```js
  // ===== 浏览窗口（统一中心）状态 =====
  let browseCache = null;               // 浏览窗口的缓存快照（内存中，不写回）
  let browseNewKeys = new Set();        // 会话级「新」徽标：'courseId:classroomId:resourceId'

  function keyOf(course, resource) {
    return course.courseId + ':' + course.classroomId + ':' + resource.resourceId;
  }
```

- [ ] **Step 3: `openBrowse` + 第一级 `renderCourses`**

在 `keyOf` 之后新增：

```js
  async function openBrowse() {
    closePanel();
    browseCache = Store.load();
    browseNewKeys = new Set();
    renderCourses();
  }

  // 第一级：课程列表（或空状态）
  function renderCourses(notice) {
    closePanel();
    const mask = document.createElement('div');
    mask.className = 'rcppt-mask';
    const panel = document.createElement('div');
    panel.className = 'rcppt-panel';

    const top = document.createElement('div');
    top.className = 'rcppt-browse-top';
    const title = document.createElement('span');
    title.textContent = '📚 已扫描课件';
    const btnScan = document.createElement('button');
    btnScan.className = 'rcppt-scan';
    btnScan.textContent = '扫描';
    btnScan.addEventListener('click', () => scanAndRefresh(panel, btnScan));
    top.append(title, btnScan);
    panel.appendChild(top);

    if (notice) {
      const banner = document.createElement('div');
      banner.className = 'rcppt-notice';
      banner.textContent = notice;
      panel.appendChild(banner);
    }

    if (!browseCache.courses.length) {
      const empty = document.createElement('div');
      empty.className = 'rcppt-empty';
      empty.textContent = '暂无已扫描课件';
      const btnStart = document.createElement('button');
      btnStart.className = 'rcppt-scan';
      btnStart.textContent = '开始扫描';
      btnStart.addEventListener('click', () => scanAndRefresh(panel, btnStart));
      panel.append(empty, btnStart);
    } else {
      const list = document.createElement('div');
      browseCache.courses.forEach((course, i) => {
        const row = document.createElement('div');
        row.className = 'rcppt-row rcppt-course';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.index = String(i);
        const name = document.createElement('span');
        name.textContent = course.className ? `${course.courseName} (${course.className})` : course.courseName;
        const count = document.createElement('span');
        count.className = 'rcppt-count';
        count.textContent = course.resources.length + ' 课件';
        row.append(cb, name, count);
        const newCount = course.resources.filter((r) => browseNewKeys.has(keyOf(course, r))).length;
        if (newCount) {
          const nb = document.createElement('span');
          nb.className = 'rcppt-badge new';
          nb.textContent = '+' + newCount + ' 新';
          row.append(nb);
        }
        cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
        row.addEventListener('click', (e) => { if (e.target !== cb) renderFiles(course); });
        list.appendChild(row);
      });
      panel.appendChild(list);
    }

    const bar = document.createElement('div');
    const btnSelectAll = document.createElement('button');
    btnSelectAll.textContent = '全选';
    btnSelectAll.addEventListener('click', () => {
      panel.querySelectorAll('.rcppt-row input[type=checkbox]').forEach((cb) => {
        if (!cb.disabled) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      });
    });
    const btnDownload = document.createElement('button');
    btnDownload.textContent = '下载选中';
    btnDownload.addEventListener('click', () => onDownloadSelectedCourses(panel));
    const btnClear = document.createElement('button');
    btnClear.textContent = '清空缓存';
    btnClear.addEventListener('click', onClearCache);
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClear, btnClose);
    panel.appendChild(bar);

    const noticeFooter = document.createElement('div');
    noticeFooter.textContent = '课件版权归授课教师所有，仅供个人学习使用，请勿传播';
    panel.appendChild(noticeFooter);

    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.append(mask, panel);
  }
```

- [ ] **Step 4: 第二级 `renderFiles` + 下载选中（两级）+ 清缓存 + 窗口内扫描**

在 `renderCourses` 之后新增：

```js
  // 第二级：某课的文件列表
  function renderFiles(course) {
    closePanel();
    const mask = document.createElement('div');
    mask.className = 'rcppt-mask';
    const panel = document.createElement('div');
    panel.className = 'rcppt-panel';

    const top = document.createElement('div');
    top.className = 'rcppt-browse-top';
    const btnBack = document.createElement('button');
    btnBack.textContent = '← 返回';
    btnBack.addEventListener('click', renderCourses);
    const title = document.createElement('span');
    title.textContent = course.className ? `${course.courseName} (${course.className})` : course.courseName;
    top.append(btnBack, title);
    panel.appendChild(top);

    const list = document.createElement('div');
    course.resources.forEach((resource, i) => {
      const row = document.createElement('div');
      row.className = 'rcppt-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.index = String(i);
      const badge = document.createElement('span');
      badge.className = 'rcppt-badge ' + resource.type;
      badge.textContent = resource.type === 'pdf' ? 'PDF' : resource.type === 'pptx' ? 'PPTX' : 'PPT(打印)';
      const name = document.createElement('span');
      name.textContent = resource.name;
      row.append(cb, badge, name);
      if (browseNewKeys.has(keyOf(course, resource))) {
        const nb = document.createElement('span');
        nb.className = 'rcppt-badge new';
        nb.textContent = '新';
        row.append(nb);
      }
      // 下载链路 dataset（与旧面板一致）
      row.dataset.url = resource.url || '';
      row.dataset.name = resource.name;
      row.dataset.type = resource.type;
      row.dataset.classroomId = course.classroomId;
      row.dataset.leafId = resource.resourceId;
      cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
      list.appendChild(row);
    });
    panel.appendChild(list);

    const bar = document.createElement('div');
    const btnSelectAll = document.createElement('button');
    btnSelectAll.textContent = '全选';
    btnSelectAll.addEventListener('click', () => {
      panel.querySelectorAll('.rcppt-row input[type=checkbox]').forEach((cb) => {
        if (!cb.disabled) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      });
    });
    const btnDownload = document.createElement('button');
    btnDownload.textContent = '下载选中';
    btnDownload.addEventListener('click', () => onDownloadSelectedFiles(panel));
    const btnClear = document.createElement('button');
    btnClear.textContent = '清空缓存';
    btnClear.addEventListener('click', onClearCache);
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClear, btnClose);
    panel.appendChild(bar);

    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.append(mask, panel);
  }

  // 第一级：勾选课程 → 批量下载该课全部文件
  async function onDownloadSelectedCourses(panel) {
    const courseRefs = Array.from(panel.querySelectorAll('.rcppt-row input[type=checkbox]:checked')).map((cb) => {
      const c = browseCache.courses[Number(cb.dataset.index)];
      return { courseId: c.courseId, classroomId: c.classroomId };
    });
    if (!courseRefs.length) { alert('未勾选任何课程'); return; }
    const files = Logic.collectSelection(browseCache, courseRefs, null);
    if (!files.length) { alert('所选课程暂无文件'); return; }
    const status = document.createElement('div');
    status.className = 'rcppt-status-line';
    panel.appendChild(status);
    const { ok, fail } = await downloadFiles(files, (i, text, color) => {
      status.textContent = `${text} ${i + 1}/${files.length}`;
      status.style.color = color;
    });
    status.textContent = fail ? `完成：成功 ${ok} 个，失败 ${fail} 个` : `完成：成功下载 ${ok} 个`;
    status.style.color = fail ? '#c00' : '#2e8b57';
  }

  // 第二级：勾选文件 → 逐个下载（行内状态）
  async function onDownloadSelectedFiles(panel) {
    const rows = Array.from(panel.querySelectorAll('.rcppt-row')).filter((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      return cb && cb.checked && !cb.disabled;
    });
    if (!rows.length) { alert('未勾选任何文件'); return; }
    const files = rows.map((row) => ({
      classroomId: row.dataset.classroomId,
      resource: {
        resourceId: row.dataset.leafId,
        name: row.dataset.name,
        type: row.dataset.type,
        url: row.dataset.url
      }
    }));
    await downloadFiles(files, (i, text, color) => markRow(rows[i], text, color));
  }

  function onClearCache() {
    if (!confirm('确定清空缓存？该操作不可撤销，下次扫描将全量重新检测。')) return;
    Store.clear();
    browseCache = Logic.emptyCache();
    browseNewKeys = new Set();
    renderCourses();
  }

  // 窗口内扫描：复用 runScan → 刷新列表 + 会话「新」徽标 + 横幅
  async function scanAndRefresh(panel, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      const diff = await runScan();
      consecutiveScanErrors = 0;
      browseCache = Store.load(); // 重新读取更新后的缓存
      diff.addedResources.forEach((item) => {
        browseNewKeys.add(`${item.courseId}:${item.classroomId}:${item.resource.resourceId}`);
      });
      let notice = diff.addedResourceCount
        ? `发现 ${diff.addedResourceCount} 个新课件 / 来自 ${diff.addedCourseCount} 门课`
        : '无新增课件';
      if (diff.failed && diff.failed.length) notice += `；${diff.failed.length} 门课扫描失败已跳过，详情见控制台`;
      renderCourses(notice);
    } catch (err) {
      if (err.message === 'AUTH_EXPIRED') {
        consecutiveScanErrors = 0;
        alert('登录已失效，请重新登录后重试');
      } else {
        consecutiveScanErrors += 1;
        console.error('[雨课堂PPT下载器] 扫描失败', err);
        const hint = consecutiveScanErrors >= 2 ? '接口可能已变更，请在控制台查看详情。' : '';
        alert(hint + '扫描失败：' + err.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '扫描';
    }
  }
```

- [ ] **Step 5: 退役旧 UI（`showPanel` / `onScanClick` / `onDownloadClick`）**

删除以下整段：`function showPanel(diff) { ... }`（约 240-324 行）、`async function onScanClick() { ... }`（约 332-360 行）、`async function onDownloadClick(panel) { ... }`（Task 2 重写的版本，约 364 行起）。

注意：`onDownloadClick` 已无调用方（旧面板已删），须一并删除；`downloadFiles` / `Print.exportPdf` / `markRow` / `triggerDownload` 保留（浏览窗口使用）。`consecutiveScanErrors` 变量保留（`scanAndRefresh` 使用）。

- [ ] **Step 6: 验证**

Run: `npm test`（逻辑未动，21 绿）
代码自审：无残留对已删函数的引用（`showPanel` / `onScanClick` / `onDownloadClick` 出现次数为 0）。UI 行为留待 Task 5 Playwright 验证。

- [ ] **Step 7: Commit**

```bash
git add src/app.js
git commit -m "feat: 二级浏览窗口（统一中心）——两级列表/行高亮选中/窗口内扫描/清缓存"
```

---

### Task 4: 版本 1.1.0 + README 同步

**Files:**
- Modify: `src/app.js`（`@version`）
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: 版本号**

`src/app.js` 第 4 行 `// @version      1.0.0` → `// @version      1.1.0`
`package.json` `"version": "1.0.0"` → `"version": "1.1.0"`

- [ ] **Step 2: README「功能特性」更新**

「增量扫描」条目改为（保留增量能力描述）：

```markdown
- **二级浏览窗口**：点击悬浮按钮打开浏览窗口，第一级列出全部已扫描课程（可勾选），点击课程下钻第二级查看该课课件；勾选即整行高亮，可「下载选中」批量导出。
- **增量扫描**：窗口内点击「扫描」按钮即可扫描课程列表；已扫描过的课件自动记录在本地缓存（GM 存储），再次扫描只列出新增课件并加「新」徽标，无新增时提示「无新增课件」。
```

- [ ] **Step 3: README「使用步骤」更新**

将步骤 3-5 改为：

```markdown
3. 点击按钮打开「已扫描课件」窗口。首次使用为空，点击「开始扫描」完成全量扫描（课程较多时约需 1 分钟，按钮会显示「扫描中…」）。
4. 窗口第一级列出全部课程：勾选课程可整行选中，点击课程名下钻查看该课课件。
5. 在课件列表中勾选要下载的课件（整行高亮），点击「下载选中」逐个下载 / 导出 PDF；「清空缓存」可重置本地记录。
```

- [ ] **Step 4: README「已知限制」追加一条**

```markdown
- **第一级批量下载无逐文件进度**：勾选整门课下载时，仅显示窗口内进度行（第 N/总数 个），不逐行标记状态；课件级勾选才逐行显示 ✓/失败。
```

- [ ] **Step 5: 验证 + Commit**

Run: `npm test`（21 绿，版本改动不影响逻辑）
```bash
git add src/app.js package.json README.md
git commit -m "release: @version 1.1.0 + README 同步浏览窗口功能描述"
```

---

### Task 5: 构建 + 产物入库 + 完整验证

**Files:**
- Modify: `rainclassroom-ppt-downloader.user.js`（构建产物，强制跟踪）

- [ ] **Step 1: 构建并确认产物元数据**

Run: `npm run build`
Check: `head -15 rainclassroom-ppt-downloader.user.js` — `@version      1.1.0`，其余元数据不变。

- [ ] **Step 2: 产物强制入库**

```bash
git add -f rainclassroom-ppt-downloader.user.js
```

- [ ] **Step 3: 全量单测**

Run: `npm test`
Expected: 21 全绿。

- [ ] **Step 4: Playwright 手动 E2E 验证（仓库惯例，浏览器复用雨课堂登录态）**

在 `https://changjiang.yuketang.cn/v2/web/index` 注入构建产物，逐一核验：

- [ ] 主按钮点击打开浏览窗口（不触发扫描）
- [ ] 第一级列出全部已扫描课程（含「N 课件」计数与教室名后缀）
- [ ] 勾选课程 → 整行浅蓝背景 + 左侧色条；取消勾选恢复
- [ ] 点击课程名下钻第二级文件列表；「← 返回」回到第一级
- [ ] 第二级勾选文件 → 行高亮；「下载选中」走打印导出 PDF（CDP 或半自动回退）
- [ ] 第一级勾选课程 → 「下载选中」批量下载（窗口内进度行）
- [ ] 窗口内「扫描」：无新增 → 横幅「无新增课件」；有新增 → 横幅计数 + 新课件「新」徽标（课程行「+N 新」）
- [ ] 「清空缓存」→ confirm 弹窗 → 确认后回到空状态「暂无已扫描课件」
- [ ] 空缓存时「开始扫描」按钮可用

- [ ] **Step 5: Commit**

```bash
git add rainclassroom-ppt-downloader.user.js
git commit -m "build: 浏览窗口产物入库（@version 1.1.0）"
```

- [ ] **Step 6: 台账记录 + 合并回 master 前自检**

在 `.superpowers/sdd/2026-08-03-rainclassroom-ppt-downloader/progress.md` 末尾追加：

```markdown
Task 11 (browse-window, 2026-08-04): 二级浏览窗口统一中心——主按钮打开浏览窗口（第一级课程列表/第二级文件列表）、行高亮选中效果、窗口内扫描（会话「新」徽标 + 横幅）、两级下载选中（collectSelection 纯函数）、清空缓存两处 + confirm。逻辑单测 21 绿；UI Playwright 手动验证通过；@version 1.1.0。
```
