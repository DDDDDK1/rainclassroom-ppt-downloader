# 设置版块 + 分类下载 + 无文件提示 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为雨课堂 PPT 下载器增加设置版块（自定义保存目录 + 分类下载 + 清空缓存），并在无课件课堂下载时提示「此课堂无文件」。

**Architecture:** 设置分两层存储——简单配置（分类开关）走 GM 存储 `rcppt_settings`，目录句柄（FileSystemDirectoryHandle，结构化克隆对象）走 IndexedDB `rcppt_save_dir`。下载在批次开始时做一次路由决策：目录句柄可用且授权成功则全部走 FileSystem 写入（开启分类时按 `课程名（班级名）` 建子文件夹），否则回退原生下载。无文件场景在 `buildSlidesPdfBlob` 抛带 `isNoCourseware` 标记的错误，下载循环据此标「此课堂无文件」。

**Tech Stack:** 纯原生 JS（无运行时依赖）；Node 内置 test runner 单测；File System Access API（Chrome/Edge）；IndexedDB；GM_setValue/GM_getValue。

## Global Constraints

- **零新增运行时依赖**（不引 pdf-lib 等第三方库，沿用 v1.2.0 约束）
- 主力浏览器 Chrome/Edge；**Firefox 不支持 `showDirectoryPicker`**，必须用 `typeof window.showDirectoryPicker !== 'function'` 特性检测并回退原生下载
- 缓存结构 `rcppt_cache_v1` 与 `STORE_VERSION = 1` **不变**，旧缓存兼容
- 文件夹名用全角括号：`课程名（班级名）`
- `courseFolderName`、`coursewareNoFileError` 必须为 `src/logic.js` 中纯函数（可单测）
- 版本号硬编码在 `src/app.js` 头部 `@version`；发布产物 `rainclassroom-ppt-downloader.user.js` 由 `npm run build` 生成且**入库**
- 仓库 PUBLIC，任何推送前需用户确认

---

### Task 1: logic.js 纯函数（courseFolderName + coursewareNoFileError）

**Files:**
- Modify: `src/logic.js`（在 `return {` 前新增两个函数；在返回对象中导出）
- Test: 新建 `tests/settings-download.test.js`

**Interfaces:**
- Produces:
  - `courseFolderName(courseName: string, className: string|null|undefined): string` — 返回净化后的文件夹名，有班级名时 `课程名（班级名）`
  - `coursewareNoFileError(): Error` — 返回 `message === '此课堂无文件'` 且 `isNoCourseware === true` 的 Error 实例

- [ ] **Step 1: 写失败测试**

新建 `tests/settings-download.test.js`：

```js
// tests/settings-download.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

test('courseFolderName 有班级名 → 课程名（班级名）', () => {
  assert.equal(L.courseFolderName('高等数学', '高数A班'), '高等数学（高数A班）');
});

test('courseFolderName 无班级名 → 仅课程名', () => {
  assert.equal(L.courseFolderName('高等数学', ''), '高等数学');
  assert.equal(L.courseFolderName('高等数学', null), '高等数学');
  assert.equal(L.courseFolderName('高等数学', undefined), '高等数学');
});

test('courseFolderName 非法字符被净化', () => {
  assert.equal(L.courseFolderName('a/b\\c:d', 'x/y'), 'a_b_c_d（x_y）');
});

test('courseFolderName 空课程名 → 回退 courseware', () => {
  assert.equal(L.courseFolderName('', ''), 'courseware');
});

test('coursewareNoFileError 返回结构正确', () => {
  const e = L.coursewareNoFileError();
  assert.ok(e instanceof Error);
  assert.equal(e.message, '此课堂无文件');
  assert.equal(e.isNoCourseware, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（`L.courseFolderName is not a function`）

- [ ] **Step 3: 实现**

在 `src/logic.js` 的 `jpegDimensions` 之后、`return {` 之前加入（`sanitizeFilename` 已存在）：

```js
  // 分类下载：课程文件夹名（净化后；有班级名时用全角括号拼接）
  function courseFolderName(courseName, className) {
    const base = className ? `${courseName}（${className}）` : courseName;
    return sanitizeFilename(base);
  }

  // 无文件错误工厂：供下载链路识别「此课堂无文件」
  function coursewareNoFileError() {
    const err = new Error('此课堂无文件');
    err.isNoCourseware = true;
    return err;
  }
```

在返回对象中导出（`buildSlidesPdf` 之后追加）：

```js
    buildSlidesPdf,
    courseFolderName,
    coursewareNoFileError,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 既有 30 个 + 新增 5 个全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/logic.js tests/settings-download.test.js
git commit -m "feat: logic 新增 courseFolderName/coursewareNoFileError 纯函数"
```

---

### Task 2: 设置存储层（GM + IndexedDB）

**Files:**
- Modify: `src/app.js`（在 `const Store = {...}` 之后、`runScan` 之前插入设置存储代码）

**Interfaces:**
- Produces:
  - `Settings.load(): { categorize: boolean }`（同步，容错）
  - `Settings.save(settings: { categorize: boolean }): void`（同步）
  - `SaveDir.load(): Promise<FileSystemDirectoryHandle|undefined>`
  - `SaveDir.store(handle): Promise<void>`
  - `SaveDir.clear(): Promise<void>`

- [ ] **Step 1: 实现存储层**

在 `src/app.js` 的 `const Store = {...}` 块之后插入：

```js
  // ===== 设置存储：GM 存简单配置，IndexedDB 存目录句柄 =====
  const SETTINGS_KEY = 'rcppt_settings';
  const IDB_NAME = 'rcppt';
  const IDB_STORE = 'settings';
  const IDB_HANDLE_KEY = 'rcppt_save_dir';

  const Settings = {
    load() {
      try {
        const raw = GM_getValue(SETTINGS_KEY, '');
        const data = raw ? JSON.parse(raw) : {};
        return { categorize: Boolean(data.categorize) };
      } catch (e) {
        return { categorize: false };
      }
    },
    save(settings) {
      GM_setValue(SETTINGS_KEY, JSON.stringify({ categorize: Boolean(settings.categorize) }));
    }
  };

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const SaveDir = {
    async load() { return idbGet(IDB_HANDLE_KEY); },
    async store(handle) { return idbSet(IDB_HANDLE_KEY, handle); },
    async clear() { return idbDelete(IDB_HANDLE_KEY); }
  };
```

- [ ] **Step 2: 构建冒烟**

Run: `npm run build && npm test`
Expected: 构建成功、全部测试 PASS（本任务无新测试，改动为浏览器层）

- [ ] **Step 3: 提交**

```bash
git add src/app.js
git commit -m "feat: 设置存储层——GM 存分类开关，IndexedDB 存目录句柄"
```

---

### Task 3: UI 改造（面板三段结构 + ⚙ 入口 + 设置面板）

**Files:**
- Modify: `src/app.js`（`ensureStyles` CSS、`renderCourses`、`renderFiles`、新增 `renderSettings`/`onPickDirectory`/`onClearDirectory`）

**Interfaces:**
- Consumes: `Settings.load/save`、`SaveDir.load/store/clear`（Task 2）
- Produces:
  - `renderSettings(): void` — 打开设置面板
  - `onPickDirectory(): Promise<void>` — `showDirectoryPicker` 选目录并持久化
  - `onClearDirectory(): Promise<void>` — 清除已存目录句柄

- [ ] **Step 1: CSS 面板改三段结构**

`ensureStyles` 中 `.rcppt-panel` 改 `display:flex;flex-direction:column;overflow:hidden`，并新增 `.rcppt-list`、`.rcppt-bottom`、`.rcppt-browse-title`。原样式块改为：

```js
    style.textContent = `
      .rcppt-btn{position:fixed;right:24px;bottom:80px;z-index:2147483647;
        padding:10px 16px;border:0;border-radius:8px;background:#0088ff;color:#fff;
        cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
      .rcppt-btn[disabled]{opacity:.6;cursor:not-allowed}
      .rcppt-mask{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45)}
      .rcppt-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
        z-index:2147483647;width:640px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;
        background:#fff;border-radius:10px;padding:16px;font-size:14px;color:#222}
      .rcppt-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #eee}
      .rcppt-badge{padding:1px 6px;border-radius:4px;font-size:12px;color:#fff}
      .rcppt-badge.pdf{background:#2e8b57}.rcppt-badge.pptx{background:#1e6fba}
      .rcppt-badge.img{background:#999}
      .rcppt-row.selected{background:#e8f3ff;box-shadow:inset 3px 0 0 #0088ff}
      .rcppt-badge.new{background:#f5a623}
      .rcppt-browse-top{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:600;flex:none}
      .rcppt-browse-top .rcppt-scan{margin-left:auto;font-weight:400}
      .rcppt-browse-title{margin-right:auto;font-weight:600}
      .rcppt-list{flex:1;min-height:0;overflow:auto}
      .rcppt-bottom{flex:none;display:flex;gap:8px;margin-top:12px}
      .rcppt-empty{text-align:center;padding:28px 0;color:#888}
      .rcppt-notice{padding:8px 10px;background:#fff8e1;border:1px solid #ffd54f;border-radius:6px;margin-bottom:8px;color:#6d4c00}
      .rcppt-count{color:#999;font-size:12px}
      .rcppt-status-line{padding:4px 0;font-size:13px}
      .rcppt-course{cursor:pointer}
      .rcppt-row input[type=checkbox]{-webkit-appearance:auto;appearance:auto;width:16px;height:16px;margin:0;flex:none;opacity:1;position:static}
    `;
```

- [ ] **Step 2: renderCourses 改造（标题 class + 列表容器 + ⚙ + 移除清空缓存）**

`renderCourses` 中：
- 标题 span 加 class：`title.className = 'rcppt-browse-title';`
- 顶部追加 ⚙（在 `top.append(title, btnScan);` 处改为）：

```js
    const btnSettings = document.createElement('button');
    btnSettings.textContent = '⚙';
    btnSettings.title = '设置';
    btnSettings.addEventListener('click', renderSettings);
    top.append(title, btnScan, btnSettings);
```

- 空状态与列表均包进 `.rcppt-list`。空状态分支改为：

```js
    if (!browseCache.courses.length) {
      const list = document.createElement('div');
      list.className = 'rcppt-list';
      const empty = document.createElement('div');
      empty.className = 'rcppt-empty';
      empty.textContent = '暂无已扫描课件';
      const btnStart = document.createElement('button');
      btnStart.className = 'rcppt-scan';
      btnStart.textContent = '开始扫描';
      btnStart.addEventListener('click', () => scanAndRefresh(panel, btnStart));
      list.append(empty, btnStart);
      panel.appendChild(list);
    } else {
      const list = document.createElement('div');
      list.className = 'rcppt-list';
      browseCache.courses.forEach((course, i) => {
        // ... 现有行创建逻辑不变 ...
      });
      panel.appendChild(list);
    }
```

- 底部栏 `bar` 加 class 并移除「清空缓存」按钮：

```js
    const bar = document.createElement('div');
    bar.className = 'rcppt-bottom';
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
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClose);
    panel.appendChild(bar);
```

- [ ] **Step 3: renderFiles 改造（标题 class + 列表容器 + ⚙ + 移除清空缓存）**

`renderFiles` 中同样：
- `title.className = 'rcppt-browse-title';`
- 顶部 `top.append(btnBack, title, btnSettings);`（btnSettings 同 Step 2 创建）
- 行列表包进 `.rcppt-list`：

```js
    const list = document.createElement('div');
    list.className = 'rcppt-list';
    course.resources.forEach((resource, i) => {
      // ... 现有行创建逻辑不变 ...
    });
    panel.appendChild(list);
```

- 底部栏改为 `bar.className = 'rcppt-bottom';`，仅保留 全选 / 下载选中 / 关闭（同 Step 2，但下载回调为 `onDownloadSelectedFiles(panel)`）。

- [ ] **Step 4: 新增设置面板与目录操作**

在 `onClearCache` 之后新增：

```js
  function renderSettings() {
    closePanel();
    const mask = document.createElement('div');
    mask.className = 'rcppt-mask';
    const panel = document.createElement('div');
    panel.className = 'rcppt-panel';
    panel.style.width = '440px';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:12px';
    title.textContent = '⚙ 设置';
    panel.appendChild(title);

    // 保存目录
    const dirSection = document.createElement('div');
    dirSection.style.cssText = 'margin-bottom:16px';
    const dirLabel = document.createElement('div');
    dirLabel.textContent = '📂 保存目录';
    const dirInfo = document.createElement('div');
    dirInfo.className = 'rcppt-count';
    dirInfo.textContent = '未选择（下载将保存到浏览器默认目录）';
    SaveDir.load().then((h) => { if (h) dirInfo.textContent = '当前：' + h.name; }).catch(() => {});
    const dirBtns = document.createElement('div');
    const btnPick = document.createElement('button');
    btnPick.textContent = '选择目录';
    btnPick.addEventListener('click', onPickDirectory);
    const btnClearDir = document.createElement('button');
    btnClearDir.textContent = '清除目录';
    btnClearDir.addEventListener('click', onClearDirectory);
    dirBtns.append(btnPick, btnClearDir);
    dirSection.append(dirLabel, dirInfo, dirBtns);
    panel.appendChild(dirSection);

    // 分类下载
    const catSection = document.createElement('div');
    catSection.style.cssText = 'margin-bottom:16px';
    const catLabel = document.createElement('div');
    catLabel.textContent = '📂 分类下载';
    const catRow = document.createElement('label');
    catRow.style.cssText = 'display:flex;align-items:center;gap:8px';
    const catCb = document.createElement('input');
    catCb.type = 'checkbox';
    catCb.checked = Settings.load().categorize;
    const catText = document.createElement('span');
    catText.textContent = '按课程自动创建文件夹';
    catRow.append(catCb, catText);
    catCb.addEventListener('change', () => Settings.save({ categorize: catCb.checked }));
    catSection.append(catLabel, catRow);
    panel.appendChild(catSection);
    SaveDir.load().then((h) => {
      if (!h) { catCb.disabled = true; catText.style.color = '#999'; }
    }).catch(() => { catCb.disabled = true; });

    // 清空缓存
    const cacheSection = document.createElement('div');
    cacheSection.style.cssText = 'margin-bottom:16px';
    const cacheLabel = document.createElement('div');
    cacheLabel.textContent = '🧹 清空缓存';
    const btnClear = document.createElement('button');
    btnClear.textContent = '清空缓存';
    btnClear.addEventListener('click', onClearCache);
    cacheSection.append(cacheLabel, btnClear);
    panel.appendChild(cacheSection);

    // 关闭
    const bar = document.createElement('div');
    bar.className = 'rcppt-bottom';
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.appendChild(btnClose);
    panel.appendChild(bar);

    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.append(mask, panel);
  }

  async function onPickDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      alert('当前浏览器不支持自定义保存目录（需 Chrome/Edge）');
      return;
    }
    try {
      const handle = await window.showDirectoryPicker();
      await SaveDir.store(handle);
      renderSettings(); // 重渲染刷新「当前：目录名」
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('选择目录失败：' + (e.message || e));
    }
  }

  async function onClearDirectory() {
    await SaveDir.clear();
    renderSettings();
  }
```

- [ ] **Step 5: 构建冒烟**

Run: `npm run build && npm test`
Expected: 构建成功、全部测试 PASS

- [ ] **Step 6: 提交**

```bash
git add src/app.js
git commit -m "feat: 浏览窗口三段结构 + ⚙ 设置面板（保存目录/分类下载/清空缓存移入）"
```

---

### Task 4: 下载路由（FileSystem 写入 + 分类文件夹）

**Files:**
- Modify: `src/app.js`（重构 `exportSlidesPdf` → `buildSlidesPdfBlob`；重写 `downloadFiles`；新增 `urlBase`/`directFilename`/`fetchAsBlob`/`saveDirReady`/`writeFileToDir`/`deliverBlob`）

**Interfaces:**
- Consumes: `Settings.load`（Task 2）、`SaveDir.load`（Task 2）、`Logic.courseFolderName`（Task 1）、`Logic.sanitizeFilename`（已有）
- Produces:
  - `buildSlidesPdfBlob({classroomId, leafId}, onProgress): Promise<{blob: Blob, failed: number}>`
  - `saveDirReady(): Promise<FileSystemDirectoryHandle|null>`
  - `downloadFiles(files, mark): Promise<{ok, fail}>`（改写：批次决策目录路由）

- [ ] **Step 1: 重构 exportSlidesPdf → buildSlidesPdfBlob（返回 blob）**

把现有 `exportSlidesPdf` 替换为（保留现有错误行为，Task 5 再改无文件标记）：

```js
  // 编排：API 懒加载链 → 拉取页面 → 合成 PDF；返回 { blob, failed }
  async function buildSlidesPdfBlob({ classroomId, leafId }, onProgress) {
    const leafInfo = await Api.fetchLeafInfo(classroomId, leafId, uvIdFromCookie());
    const review = await Api.fetchReview(leafInfo.courseware_id);
    const presentationId = review.timelineList[0].presentationId;
    const slideList = await Api.fetchPpt(leafInfo.courseware_id, presentationId);
    if (!slideList || !slideList.length) throw new Error('课件无分片图片');
    const { pages, failed } = await fetchSlidePages(slideList, onProgress);
    const pdf = Logic.buildSlidesPdf(pages);
    return { blob: new Blob([pdf], { type: 'application/pdf' }), failed };
  }
```

- [ ] **Step 2: 新增下载辅助函数**

在 `downloadFiles` 之前新增：

```js
  // 直链文件名：从 URL 推导；无扩展名按类型补全（修复待办 #7）
  function urlBase(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(last);
    } catch (e) { return ''; }
  }
  function directFilename(name, url, type) {
    let base = Logic.sanitizeFilename(name || urlBase(url) || 'courseware');
    if (!/\.(pdf|pptx|ppt)$/i.test(base)) base += type === 'pptx' ? '.pptx' : '.pdf';
    return base;
  }

  async function fetchAsBlob(url) {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.blob();
  }

  // 目录句柄是否可用（含授权）；不可用返回 null（无 showDirectoryPicker / 无句柄 / 授权被拒）
  async function saveDirReady() {
    if (typeof window.showDirectoryPicker !== 'function') return null;
    let handle;
    try { handle = await SaveDir.load(); } catch (e) { return null; }
    if (!handle) return null;
    try {
      const opts = { mode: 'readwrite' };
      let perm = await handle.queryPermission(opts);
      if (perm !== 'granted') perm = await handle.requestPermission(opts);
      return perm === 'granted' ? handle : null;
    } catch (e) { return null; }
  }

  // FileSystem 写入：分类时先建课程子文件夹
  async function writeFileToDir(dirHandle, filename, blob, courseFolder) {
    let target = dirHandle;
    if (courseFolder) target = await dirHandle.getDirectoryHandle(courseFolder, { create: true });
    const fileHandle = await target.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  // 交付 blob：目录可用 → 写入；否则 objectURL 原生下载
  async function deliverBlob(dirHandle, settings, course, blob, filename) {
    if (!dirHandle) {
      const url = URL.createObjectURL(blob);
      await triggerDownload(url, filename);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }
    const courseFolder = settings.categorize ? Logic.courseFolderName(course.courseName, course.className) : null;
    await writeFileToDir(dirHandle, filename, blob, courseFolder);
  }
```

- [ ] **Step 3: 第二级下载补课程信息（分类需要 courseName/className）**

`renderFiles` 行 dataset 补课程字段（在 `row.dataset.classroomId = course.classroomId;` 附近加入）：

```js
      row.dataset.courseName = course.courseName;
      row.dataset.className = course.className || '';
```

`onDownloadSelectedFiles` 的 `files` 映射补课程字段：

```js
    const files = rows.map((row) => ({
      classroomId: row.dataset.classroomId,
      courseName: row.dataset.courseName,
      className: row.dataset.className,
      resource: {
        resourceId: row.dataset.leafId,
        name: row.dataset.name,
        type: row.dataset.type,
        url: row.dataset.url
      }
    }));
```

（第一级 `onDownloadSelectedCourses` 经 `collectSelection` 已带 courseName/className，无需改动。）

- [ ] **Step 4: 重写 downloadFiles（批次目录路由）**

把现有 `downloadFiles` 替换为：

```js
  async function downloadFiles(files, mark) {
    let ok = 0, fail = 0;
    const dirHandle = await saveDirReady();
    const settings = Settings.load();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const r = f.resource;
      if (!r) { fail++; if (mark) mark(i, '失败', '#c00'); continue; }
      if (mark) mark(i, '下载中…', '#08f');
      try {
        if (r.type === 'img') {
          const { blob, failed } = await buildSlidesPdfBlob(
            { classroomId: f.classroomId, leafId: r.resourceId },
            (done, total) => { if (mark) mark(i, '拉取图片 ' + done + '/' + total, '#08f'); }
          );
          const filename = Logic.sanitizeFilename(r.name) + '.pdf';
          await deliverBlob(dirHandle, settings, { courseName: f.courseName, className: f.className }, blob, filename);
          ok++;
          if (mark) mark(i, failed > 0 ? '✓（' + failed + ' 页失败）' : '✓', '#2e8b57');
        } else if (r.url) {
          const filename = directFilename(r.name, r.url, r.type);
          if (dirHandle) {
            // 目录模式：fetch 写入；CORS 拦截 → 回退原生
            const blob = await fetchAsBlob(r.url).catch(() => null);
            if (blob) {
              await deliverBlob(dirHandle, settings, { courseName: f.courseName, className: f.className }, blob, filename);
              ok++;
              if (mark) mark(i, '✓', '#2e8b57');
            } else {
              await triggerDownload(r.url, filename);
              ok++;
              if (mark) mark(i, '✓', '#2e8b57');
            }
          } else {
            await triggerDownload(r.url, filename);
            ok++;
            if (mark) mark(i, '✓', '#2e8b57');
          }
        } else {
          throw new Error('无下载地址');
        }
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

- [ ] **Step 5: 构建冒烟**

Run: `npm run build && npm test`
Expected: 构建成功、全部测试 PASS

- [ ] **Step 6: 提交**

```bash
git add src/app.js
git commit -m "feat: 下载路由——目录句柄可用时 FileSystem 写入，分类开关按课程建文件夹"
```

---

### Task 5: 无文件提示

**Files:**
- Modify: `src/app.js`（`buildSlidesPdfBlob` 三处抛 `coursewareNoFileError`；`downloadFiles` catch 分支）

**Interfaces:**
- Consumes: `Logic.coursewareNoFileError`（Task 1）
- Produces: `buildSlidesPdfBlob` 在无课件场景抛 `isNoCourseware === true` 的错误；`downloadFiles` 对这类错误行内标「此课堂无文件」

- [ ] **Step 1: buildSlidesPdfBlob 无课件场景抛标记错误**

把 Task 4 的 `buildSlidesPdfBlob` 改为：

```js
  async function buildSlidesPdfBlob({ classroomId, leafId }, onProgress) {
    const leafInfo = await Api.fetchLeafInfo(classroomId, leafId, uvIdFromCookie());
    if (!leafInfo.courseware_id) throw Logic.coursewareNoFileError();
    const review = await Api.fetchReview(leafInfo.courseware_id);
    if (!review || !review.timelineList || !review.timelineList.length) throw Logic.coursewareNoFileError();
    const presentationId = review.timelineList[0].presentationId;
    const slideList = await Api.fetchPpt(leafInfo.courseware_id, presentationId);
    if (!slideList || !slideList.length) throw Logic.coursewareNoFileError();
    const { pages, failed } = await fetchSlidePages(slideList, onProgress);
    const pdf = Logic.buildSlidesPdf(pages);
    return { blob: new Blob([pdf], { type: 'application/pdf' }), failed };
  }
```

- [ ] **Step 2: downloadFiles catch 区分无文件**

把 `downloadFiles` 的 catch 块改为：

```js
      } catch (e) {
        fail++;
        if (e && e.isNoCourseware) {
          console.warn('[雨课堂PPT下载器] 此课堂无文件：' + r.name);
          if (mark) mark(i, '此课堂无文件', '#999');
        } else {
          console.warn('[雨课堂PPT下载器] 下载失败：' + r.name + ' — ' + e.message);
          if (mark) mark(i, '失败', '#c00');
        }
      }
```

- [ ] **Step 3: 构建冒烟**

Run: `npm run build && npm test`
Expected: 构建成功、全部测试 PASS

- [ ] **Step 4: 提交**

```bash
git add src/app.js
git commit -m "feat: 无课件课堂下载标「此课堂无文件」而非失败"
```

---

### Task 6: 版本号 + README + 构建产物 + 全量验证

**Files:**
- Modify: `src/app.js`（头部 `@version`）、`package.json`（`version`）、`README.md`
- Build: `rainclassroom-ppt-downloader.user.js`（产物入库）

- [ ] **Step 1: 版本号 1.2.0 → 1.3.0**

`src/app.js` 头部 `// @version      1.2.0` → `// @version      1.3.0`；`package.json` 的 `"version": "1.1.0"` → `"version": "1.3.0"`。

- [ ] **Step 2: README 同步**

- 「功能特性」新增：
  - **设置版块**：悬浮浏览窗口右上角 ⚙ 进入设置——自定义保存目录（跨会话记住）、按课程自动分类下载、清空缓存
  - **无文件提示**：无课件的课堂下载时行内提示「此课堂无文件」，不再笼统显示失败
- 「使用教程」第 4/5 步后补充：
  - 点击窗口右上角 ⚙ 打开设置：可「选择目录」自定义保存位置（Chrome/Edge）；勾选「按课程自动创建文件夹」后下载自动按 `课程名（班级名）` 归档；「清空缓存」已移入设置
- 「已知限制」补充：
  - 自定义保存目录与分类下载依赖 Chrome/Edge 的 File System Access API，Firefox 不支持（自动回退浏览器默认下载目录）

- [ ] **Step 3: 构建产物 + 全量测试**

Run: `npm run build && npm test`
Expected: 构建成功；既有 30 + 新增 5 个测试全部 PASS

- [ ] **Step 4: 产物入库**

```bash
git add rainclassroom-ppt-downloader.user.js
```

- [ ] **Step 5: Playwright 手动验证**

用仓库惯例（浏览器复用登录态）验证：
- ⚙ 打开设置面板；「选择目录」后显示目录名；「清除目录」生效
- 分类开关：开启后下载多门课 → 每课生成 `课程名（班级名）` 文件夹、文件落位正确
- 未选目录下载 → 回退原生下载
- 无课件课堂下载 → 行内「此课堂无文件」（灰色）
- 面板滚动时顶部栏（⚙/扫描）保持可见；底部栏不再有「清空缓存」

- [ ] **Step 6: 提交**

```bash
git add src/app.js package.json README.md rainclassroom-ppt-downloader.user.js
git commit -m "release: v1.3.0——设置版块/分类下载/无文件提示"
```
