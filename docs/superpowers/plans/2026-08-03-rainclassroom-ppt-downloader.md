# 长江雨课堂PPT下载器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开发一个油猴脚本，在长江雨课堂（changjiang.yuketang.cn）页面提供手动触发按钮，增量扫描"我听的课"中的 PPT/PDF 课件并逐个下载。

**Architecture:** 单文件 `.user.js`（IIFE + 严格模式），内部 6 组件（init/Store/Api/Scanner/UI/Downloader）。纯逻辑（缓存、增量对比、类型识别）抽到 `src/logic.js`（UMD，可被 Node 测试），浏览器适配（GM、fetch、DOM）在 `src/app.js`，`build.js` 合并二者生成发布版。

**Tech Stack:** 原生 JavaScript（无第三方库、无 `@require`）；Node 内置 `node:test` 做纯逻辑单测；Tampermonkey GM API（仅 `GM_setValue`/`GM_getValue`）。

## Global Constraints

- 最终产物 `rainclassroom-ppt-downloader.user.js`：**UTF-8 无 BOM**，元数据连续置顶，不插入业务代码
- `@match https://changjiang.yuketang.cn/*`，禁止通配全局匹配
- `@grant` 仅 `GM_setValue`、`GM_getValue`；无外部库、无 `@require`
- 中文 UI；无 eval/new Function；面板内容用 `textContent` 不用 innerHTML 渲染外部数据
- 增量判定唯一键 = `courseId + resourceId`（不依赖名称）
- 不引入 JSZip；下载逐个触发，间隔 ≥800ms；扫描请求间隔 500~1200ms、逐课串行
- 测试运行：`node --test tests/`；构建：`npm run build`

---

### Task 1: 接口调研与抓包（前置，人工协作）

**Files:**
- Create: `docs/apis.md`（接口契约清单）

**Interfaces:**
- Produces: 下述两个接口的完整契约，Task 5 依据它写 Api 层。若发现复杂签名加密 → 停止并回退评估（见设计文档风险回退）。

- [ ] **Step 1: 登录并打开页面**
  浏览器登录 `https://changjiang.yuketang.cn`，进入"我听的课"，F12 打开 Network 面板。

- [ ] **Step 2: 定位课程列表接口**
  在"我听的课"列表加载时，过滤 XHR 请求，找出返回课程数组的接口。记录：`URL`、`method`、`入参`（含分页参数名）、`响应中课程对象的字段`（课程唯一 ID 字段名、课程名字段名）。

- [ ] **Step 3: 定位课件列表接口**
  点进任一课程，找出返回课件列表的接口。记录：`URL`、`method`、`入参`（含课程 ID 参数名）、`响应中课件对象的字段`（课件唯一 ID、课件名、类型字段名、资源 URL 字段）。

- [ ] **Step 4: 验证直链与签名**
  打开一个课件的预览地址，确认响应是「原始文件（pdf/pptx）」还是「图片分片」。检查请求是否携带 sign/timestamp 等签名参数。

- [ ] **Step 5: 填写契约文档**
  在 `docs/apis.md` 中填写下述模板（字段名按真实抓包结果替换）：

```markdown
# 接口契约（抓包结果）

## 1. 课程列表
- URL: `POST/GET <抓包所得>`
- 入参: `{ <入参> }`
- 分页: 参数名 `<name>`，是否必传
- 课程对象字段: courseId=`, courseName=`, 列表字段=`

## 2. 课件列表
- URL: `POST/GET <抓包所得>`
- 入参: `{ courseId, <其他> }`
- 课件对象字段: resourceId=`, name=`, type=`, url=`
- 图片流判断依据: <哪些值/缺省表示分片图片流>

## 3. 签名情况
- 是否带 sign/加密: 是/否（若是 → 停止，回退评估）
```

- [ ] **Step 6: 提交**

```bash
git add docs/apis.md
git commit -m "docs: 记录长江雨课堂接口抓包契约"
```

---

### Task 2: 项目骨架 + 构建链 + 冒烟测试

**Files:**
- Create: `package.json`
- Create: `build.js`
- Create: `src/logic.js`（UMD 空骨架）
- Create: `src/app.js`（元数据头 + 注入占位）
- Create: `tests/smoke.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `npm test` 可跑通冒烟测试；`npm run build` 生成 `rainclassroom-ppt-downloader.user.js`；`src/logic.js` 导出对象 `RCLogic`（后续任务往里加方法）

- [ ] **Step 1: 写冒烟测试**

```js
// tests/smoke.test.js
const test = require('node:test');
const assert = require('node:assert');
const RCLogic = require('../src/logic.js');

test('logic module exports expected namespaces', () => {
  assert.ok(RCLogic, 'RCLogic should be exported');
  assert.equal(typeof RCLogic, 'object');
});
```

- [ ] **Step 2: 创建 `package.json`**

```json
{
  "name": "rainclassroom-ppt-downloader",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "node build.js",
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 3: 创建 `src/logic.js`（UMD 骨架）**

```js
'use strict';
const RCLogic = (function () {
  return {
    // 后续任务填充：buildCache / diffCourses / classifyResource
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RCLogic;
}
```

- [ ] **Step 4: 创建 `build.js`**

```js
const fs = require('fs');
const path = require('path');

const logic = fs.readFileSync(path.join(__dirname, 'src', 'logic.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'src', 'app.js'), 'utf8');

const output = app.replace('/* __LOGIC__ */', logic);
fs.writeFileSync(
  path.join(__dirname, 'rainclassroom-ppt-downloader.user.js'),
  output,
  { encoding: 'utf8' }
);
console.log('Build complete: rainclassroom-ppt-downloader.user.js');
```

- [ ] **Step 5: 创建 `src/app.js`（元数据头 + 注入占位）**

```js
// ==UserScript==
// @name         长江雨课堂PPT下载器
// @namespace    https://github.com/DDDDDK1/rainclassroom-ppt-downloader
// @version      0.1.0
// @description  便捷下载长江雨课堂中的PPT课件（增量检测）
// @author       DDDDDK1
// @match        https://changjiang.yuketang.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

/* __LOGIC__ */

(function () {
  'use strict';
  const Logic = window.RCLogic;

  console.log('[雨课堂PPT下载器] 脚本已加载', Logic);
})();
```

- [ ] **Step 6: 跑冒烟测试**

Run: `npm test`
Expected: `tests 1`，PASS

- [ ] **Step 7: 跑构建**

Run: `npm run build`
Expected: 生成 `rainclassroom-ppt-downloader.user.js`，文件头部为元数据块，内含 `RCLogic` 定义

- [ ] **Step 8: 提交**

```bash
git add package.json build.js src/logic.js src/app.js tests/smoke.test.js
git commit -m "chore: 初始化项目骨架与构建链"
```

---

### Task 3: Store 纯逻辑（TDD）

**Files:**
- Modify: `src/logic.js`
- Create: `tests/store.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `RCLogic.parseCache(raw)` / `RCLogic.serializeCache(cache)` / `RCLogic.upsertCourse(cache, course)` / `RCLogic.emptyCache()` — 数据形状遵循设计文档第四节

- [ ] **Step 1: 写失败测试**

```js
// tests/store.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

test('emptyCache 返回空结构', () => {
  const c = L.emptyCache();
  assert.equal(c.version, 1);
  assert.deepEqual(c.courses, []);
});

test('parseCache 对非法 JSON 返回空缓存而非抛错', () => {
  const c = L.parseCache('not-json{{{');
  assert.deepEqual(c, L.emptyCache());
});

test('parseCache 序列化往返一致', () => {
  const c = L.emptyCache();
  const restored = L.parseCache(L.serializeCache(c));
  assert.deepEqual(restored, c);
});

test('upsertCourse 新增课程', () => {
  const cache = L.emptyCache();
  const course = { courseId: 'c1', courseName: '高数', resources: [], scanTime: 1 };
  const next = L.upsertCourse(cache, course);
  assert.equal(next.courses.length, 1);
  assert.equal(next.courses[0].courseName, '高数');
  // 不修改原对象
  assert.equal(cache.courses.length, 0);
});

test('upsertCourse 更新已有课程（同 courseId）', () => {
  const cache = L.emptyCache();
  cache.courses.push({ courseId: 'c1', courseName: '旧名', resources: [], scanTime: 1 });
  const course = { courseId: 'c1', courseName: '新名', resources: [{ resourceId: 'r1' }], scanTime: 2 };
  const next = L.upsertCourse(cache, course);
  assert.equal(next.courses.length, 1);
  assert.equal(next.courses[0].courseName, '新名');
  assert.equal(next.courses[0].resources.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/store.test.js`
Expected: FAIL，`L.emptyCache is not a function`

- [ ] **Step 3: 实现 Store 纯函数**

```js
// 追加到 src/logic.js 的 return 对象内
const STORE_VERSION = 1;

function emptyCache() {
  return { version: STORE_VERSION, courses: [] };
}

function parseCache(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.courses)) return emptyCache();
    return data;
  } catch (e) {
    return emptyCache();
  }
}

function serializeCache(cache) {
  return JSON.stringify(cache);
}

function upsertCourse(cache, course) {
  const courses = cache.courses.filter((c) => c.courseId !== course.courseId);
  courses.push(course);
  return { version: cache.version, courses };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/store.test.js`
Expected: 5 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/logic.js tests/store.test.js
git commit -m "feat: 实现Store缓存纯逻辑"
```

---

### Task 4: 类型识别 + 增量对比（TDD）

**Files:**
- Modify: `src/logic.js`
- Create: `tests/scanner.test.js`

**Interfaces:**
- Consumes: `RCLogic.upsertCourse`（Task 3）
- Produces:
  - `RCLogic.classifyResource(item)` → `'pdf' | 'pptx' | 'img' | 'other'`
  - `RCLogic.diffCourses(existingCache, fetchedCourses)` → `{ addedResources: [{ courseId, courseName, resource }], addedCourseCount, addedResourceCount }`（`fetchedCourses` 每项含 `courseId/courseName/resources[]`，`resources[]` 每项为 `{ resourceId, name, type, url }`）

- [ ] **Step 1: 写失败测试**

```js
// tests/scanner.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

test('classifyResource 识别 pdf / pptx / 图片流 / 其他', () => {
  assert.equal(L.classifyResource({ type: 'pdf' }), 'pdf');
  assert.equal(L.classifyResource({ type: 'pptx' }), 'pptx');
  assert.equal(L.classifyResource({ type: 'ppt' }), 'img'); // ppt 分片预览 → 图片流
  assert.equal(L.classifyResource({ file_type: 'video' }), 'other');
  assert.equal(L.classifyResource({ type: '', url: null }), 'other');
});

test('diffCourses 空缓存 → 全部课程视为新增', () => {
  const fetched = [
    {
      courseId: 'c1', courseName: '高数',
      resources: [{ resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1' }]
    }
  ];
  const diff = L.diffCourses(L.emptyCache(), fetched);
  assert.equal(diff.addedCourseCount, 1);
  assert.equal(diff.addedResourceCount, 1);
  assert.equal(diff.addedResources[0].courseId, 'c1');
});

test('diffCourses 已存在课程仅报新增课件', () => {
  const cache = L.emptyCache();
  cache.courses.push({
    courseId: 'c1', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1', scanTime: 1 }],
    scanTime: 1
  });
  const fetched = [
    {
      courseId: 'c1', courseName: '高数',
      resources: [
        { resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1' },
        { resourceId: 'r2', name: '第2章.pdf', type: 'pdf', url: 'u2' }
      ]
    }
  ];
  const diff = L.diffCourses(cache, fetched);
  assert.equal(diff.addedCourseCount, 0);
  assert.equal(diff.addedResourceCount, 1);
  assert.equal(diff.addedResources[0].resource.resourceId, 'r2');
});

test('diffCourses 同 resourceId 重名也判定为已存在', () => {
  const cache = L.emptyCache();
  cache.courses.push({
    courseId: 'c1', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '重名.pdf', type: 'pdf', url: 'u1', scanTime: 1 }],
    scanTime: 1
  });
  const fetched = [{
    courseId: 'c1', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '重名.pdf', type: 'pdf', url: 'u1' }]
  }];
  assert.equal(L.diffCourses(cache, fetched).addedResourceCount, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/scanner.test.js`
Expected: FAIL，`L.classifyResource is not a function`

- [ ] **Step 3: 实现类型识别与增量对比**

```js
// 追加到 src/logic.js
function classifyResource(item) {
  const type = String(item.type || item.file_type || '').toLowerCase();
  const name = String(item.name || '').toLowerCase();
  if (type === 'pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === 'pptx' || type === 'ppt' && item.url) return 'pptx';
  // ppt 分片预览（无原始文件）→ 图片流
  if (type === 'ppt' || type === 'image' || type === 'img') return 'img';
  if (type === 'video' || type === 'audio') return 'other';
  return 'other';
}

function diffCourses(existingCache, fetchedCourses) {
  const addedResources = [];
  let addedCourseCount = 0;
  let addedResourceCount = 0;

  for (const fetched of fetchedCourses) {
    const existingCourse = existingCache.courses.find(
      (c) => c.courseId === fetched.courseId
    );
    const knownIds = new Set((existingCourse ? existingCourse.resources : []).map((r) => r.resourceId));

    if (!existingCourse) addedCourseCount += 1;

    for (const resource of fetched.resources || []) {
      const type = classifyResource(resource);
      if (type === 'other') continue;          // 过滤视频/音频/无关项
      if (knownIds.has(resource.resourceId)) continue; // 已存在 → 跳过
      addedResources.push({
        courseId: fetched.courseId,
        courseName: fetched.courseName,
        resource: { ...resource, type, scanTime: Date.now() }
      });
    }
  }

  addedResourceCount = addedResources.length;
  return { addedResources, addedCourseCount, addedResourceCount };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/scanner.test.js`
Expected: 4 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/logic.js tests/scanner.test.js
git commit -m "feat: 实现类型识别与增量对比纯逻辑"
```

---

### Task 5: Api 层（fetch 封装，依据 Task 1 契约）

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `docs/apis.md`（Task 1 的接口契约）
- Produces: `Api.fetchCourses()` → `Promise<[{ courseId, courseName }]>`；`Api.fetchResources(courseId)` → `Promise<[{ resourceId, name, type, url }]>`；`Api` 顶部 `API_BASE` 常量集中管理接口地址

- [ ] **Step 1: 在 `src/app.js` 的 IIFE 内加入 Api 组件**

```js
// 接口地址集中常量（依据 docs/apis.md 的 Task 1 实际抓包结果修改）
const API = {
  listCourses: '<docs/apis.md 课程列表 URL>',
  listResources: '<docs/apis.md 课件列表 URL>'
};

const Api = {
  async fetchCourses() {
    // 依据 docs/apis.md：method、入参、分页遍历、响应字段映射
    // 示例：分页拉取全部课程
    const all = [];
    let page = 1;
    for (;;) {
      const data = await fetchJson(API.listCourses, buildCoursesPayload(page));
      all.push(...extractCourses(data));
      if (!hasMore(data)) break;
      page += 1;
      await sleep(500);
    }
    return all;
  },

  async fetchResources(courseId) {
    const data = await fetchJson(API.listResources, buildResourcesPayload(courseId));
    return extractResources(data);
  }
};
```

- [ ] **Step 2: 补齐通用请求/工具函数**

```js
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fetchJson(url, payload) {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (payload) opts.body = JSON.stringify(payload);
  return fetch(url, opts).then(async (res) => {
    if (res.status === 401) throw Object.assign(new Error('AUTH_EXPIRED'), { code: 401 });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

// 以下三个映射函数依据 docs/apis.md 的实际字段实现：
function buildCoursesPayload(page) { /* TODO 依据契约 */ }
function extractCourses(data) { /* TODO 依据契约 */ }
function buildResourcesPayload(courseId) { /* TODO 依据契约 */ }
function extractResources(data) { /* TODO 依据契约 */ }
```

- [ ] **Step 3: 浏览器手动验证**

在控制台执行 `Api.fetchCourses()`，确认返回课程数组；对第一门课执行 `Api.fetchResources(courseId)`，确认课件对象含 resourceId/name/type/url 字段。若有签名加密 → 停止回退。

- [ ] **Step 4: 重新构建并提交**

Run: `npm run build`
```bash
git add src/app.js
git commit -m "feat: 实现Api层fetch封装"
```

---

### Task 6: Scanner 装配 + 控制台验证

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `RCLogic.diffCourses` / `RCLogic.upsertCourse` / `RCLogic.parseCache` / `RCLogic.serializeCache`（Task 3-4）、`Api.fetchCourses` / `Api.fetchResources`（Task 5）、`GM_getValue/GM_setValue`
- Produces: `runScan()` → `Promise<{ addedResources, addedCourseCount, addedResourceCount }>`（扫描成功后同步更新缓存）

- [ ] **Step 1: 在 `src/app.js` 加入 Store 适配与 Scanner**

```js
const STORE_KEY = 'rcppt_cache_v1';

const Store = {
  load() { return Logic.parseCache(GM_getValue(STORE_KEY, '')); },
  save(cache) { GM_setValue(STORE_KEY, Logic.serializeCache(cache)); },
  clear() { GM_setValue(STORE_KEY, ''); }
};

async function runScan() {
  const cache = Store.load();
  const courses = await Api.fetchCourses();
  const fetched = [];

  for (const course of courses) {
    const resources = await Api.fetchResources(course.courseId);
    fetched.push({ ...course, resources });
    await sleep(800); // 逐课串行 + 请求间隔
  }

  const diff = Logic.diffCourses(cache, fetched);

  // 同步更新缓存（幂等：全部成功后写入）
  let next = cache;
  for (const course of fetched) {
    const normalized = {
      courseId: course.courseId,
      courseName: course.courseName,
      resources: course.resources
        .filter((r) => Logic.classifyResource(r) !== 'other')
        .map((r) => ({ ...r, type: Logic.classifyResource(r), scanTime: Date.now() })),
      scanTime: Date.now()
    };
    next = Logic.upsertCourse(next, normalized);
  }
  Store.save(next);

  return diff;
}
```

- [ ] **Step 2: 控制台验证首次扫描**

在页面控制台调用 `runScan()`：首次（空缓存）应返回全部课程课件为新增；再次调用应返回 `addedResourceCount: 0`。

- [ ] **Step 3: 提交**

```bash
git add src/app.js
git commit -m "feat: 实现Scanner增量扫描装配"
```

---

### Task 7: UI 层（悬浮按钮 + 模态面板）

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `runScan()`（Task 6）
- Produces: 悬浮按钮（右下角）；模态面板渲染 `diff.addedResources`；面板操作事件（全选/下载选中/重扫/清空/关闭）；SPA 路由保活

- [ ] **Step 1: 注入悬浮按钮与样式**

```js
function ensureStyles() {
  const id = 'rcppt-style';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    .rcppt-btn{position:fixed;right:24px;bottom:80px;z-index:2147483647;
      padding:10px 16px;border:0;border-radius:8px;background:#0088ff;color:#fff;
      cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
    .rcppt-btn[disabled]{opacity:.6;cursor:not-allowed}
    .rcppt-mask{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45)}
    .rcppt-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
      z-index:2147483647;width:640px;max-width:92vw;max-height:80vh;overflow:auto;
      background:#fff;border-radius:10px;padding:16px;font-size:14px;color:#222}
    .rcppt-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #eee}
    .rcppt-badge{padding:1px 6px;border-radius:4px;font-size:12px;color:#fff}
    .rcppt-badge.pdf{background:#2e8b57}.rcppt-badge.pptx{background:#1e6fba}
    .rcppt-badge.img{background:#999}
  `;
  document.head.appendChild(style);
}

function ensureButton() {
  if (document.querySelector('.rcppt-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'rcppt-btn';
  btn.textContent = '📄 雨课堂PPT下载';
  btn.addEventListener('click', onScanClick);
  document.body.appendChild(btn);
}
```

- [ ] **Step 2: 模态面板渲染**

```js
function showPanel(diff) {
  closePanel();
  const mask = document.createElement('div');
  mask.className = 'rcppt-mask';
  const panel = document.createElement('div');
  panel.className = 'rcppt-panel';
  panel.innerHTML = ''; // 静态骨架用模板，动态课件名一律 textContent

  const summary = document.createElement('div');
  summary.textContent = `发现 ${diff.addedResourceCount} 个新课件 / 来自 ${diff.addedCourseCount} 门课`;
  panel.appendChild(summary);

  const list = document.createElement('div');
  diff.addedResources.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'rcppt-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.index = String(i);
    cb.disabled = item.resource.type === 'img'; // 图片流禁用
    const badge = document.createElement('span');
    badge.className = 'rcppt-badge ' + item.resource.type;
    badge.textContent = item.resource.type === 'pdf' ? 'PDF' : item.resource.type === 'pptx' ? 'PPTX' : '图片流';
    const name = document.createElement('span');
    name.textContent = item.resource.name; // textContent，防注入
    const course = document.createElement('span');
    course.textContent = item.courseName;
    if (item.resource.type === 'img') {
      row.title = '仅图片预览，无法下载源文件';
    }
    row.append(cb, badge, name, course);
    list.appendChild(row);
  });
  panel.appendChild(list);

  // 操作区：全选 / 下载选中 / 重新扫描 / 清空列表 / 关闭
  const bar = document.createElement('div');
  const btnSelectAll = document.createElement('button');
  btnSelectAll.textContent = '全选';
  const btnDownload = document.createElement('button');
  btnDownload.textContent = '下载选中';
  btnDownload.addEventListener('click', () => onDownloadClick(panel));
  const btnClose = document.createElement('button');
  btnClose.textContent = '关闭';
  btnClose.addEventListener('click', closePanel);
  bar.append(btnSelectAll, btnDownload, btnClose);
  panel.appendChild(bar);

  const notice = document.createElement('div');
  notice.textContent = '课件版权归授课教师所有，仅供个人学习使用，请勿传播';
  panel.appendChild(notice);

  mask.appendChild(panel);
  mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
  document.body.append(mask, panel);
}

function closePanel() {
  document.querySelectorAll('.rcppt-mask, .rcppt-panel').forEach((n) => n.remove());
}
```

- [ ] **Step 3: 扫描点击处理 + 防重复**

```js
async function onScanClick() {
  const btn = document.querySelector('.rcppt-btn');
  if (btn.disabled) return; // 防重复
  btn.disabled = true;
  btn.textContent = '扫描中…';
  try {
    const diff = await runScan();
    if (diff.addedResourceCount === 0) {
      alert('无新增课件');
      return;
    }
    showPanel(diff);
  } catch (err) {
    alert(err.message === 'AUTH_EXPIRED' ? '登录已失效，请重新登录后重试' : '扫描失败：' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📄 雨课堂PPT下载';
  }
}
```

- [ ] **Step 4: SPA 路由保活（按钮跨页面切换不消失）**

```js
function keepAlive() {
  const orig = history.pushState;
  history.pushState = function (...args) {
    const ret = orig.apply(this, args);
    setTimeout(ensureButton, 500);
    return ret;
  };
  new MutationObserver(() => {
    if (document.body && !document.querySelector('.rcppt-btn')) ensureButton();
  }).observe(document.documentElement, { childList: true, subtree: true });
}
```

- [ ] **Step 5: 入口初始化**

```js
ensureStyles();
keepAlive();
if (document.body) ensureButton(); else window.addEventListener('DOMContentLoaded', ensureButton);
```

- [ ] **Step 6: 浏览器手动验证 + 提交**

Run: `npm run build`
验证：页面右下角出现按钮；点击可扫描；重复点击不会出现多个按钮/面板。
```bash
git add src/app.js
git commit -m "feat: 实现UI悬浮按钮与模态面板"
```

---

### Task 8: 下载器（逐个下载）

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `showPanel` 中的勾选状态（Task 7）
- Produces: `onDownloadClick(panel)` → 对勾选且可下载的课件逐个触发下载，800ms 间隔，行内状态反馈

- [ ] **Step 1: 实现下载逻辑**

```js
async function onDownloadClick(panel) {
  const rows = panel.querySelectorAll('.rcppt-row');
  const targets = Array.from(rows).filter((row) => {
    const cb = row.querySelector('input[type=checkbox]');
    return cb && cb.checked && !cb.disabled;
  });

  for (const row of targets) {
    const url = row.dataset.url;
    const name = row.dataset.name;
    if (!url) { markRow(row, '无下载地址', '#c00'); continue; }
    markRow(row, '下载中…', '#08f');
    try {
      await triggerDownload(url, name);
      markRow(row, '✓', '#2e8b57');
    } catch (e) {
      markRow(row, '失败', '#c00');
    }
    await sleep(800);
  }
}

function triggerDownload(url, name) {
  return new Promise((resolve) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(resolve, 200); // 给浏览器处理下载的时间
  });
}

function markRow(row, text, color) {
  let status = row.querySelector('.rcppt-status');
  if (!status) {
    status = document.createElement('span');
    status.className = 'rcppt-status';
    row.appendChild(status);
  }
  status.textContent = text;
  status.style.color = color;
}
```

- [ ] **Step 2: 在 Task 7 的渲染代码中为可下载行补 `dataset.url` / `dataset.name`**

在 `showPanel` 的 row 构建处追加：

```js
row.dataset.url = item.resource.url || '';
row.dataset.name = item.resource.name;
```

- [ ] **Step 3: 浏览器验证 + 提交**

Run: `npm run build`
验证：勾选 2 个以上可下载课件，逐个成功下载；浏览器如弹"允许多个文件下载"提示，属于预期行为。
```bash
git add src/app.js
git commit -m "feat: 实现逐个下载器"
```

---

### Task 9: 容错加固

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: Task 5-8 各组件
- Produces: 401 提示、接口限流/5xx 延时重试（最多 3 次）、缓存损坏自愈、接口失效提示、面板重复打开聚焦

- [ ] **Step 1: Api 层加重试封装**

```js
async function fetchWithRetry(url, payload, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchJson(url, payload);
    } catch (err) {
      if (err.code === 401) throw err; // 登录失效不重试
      lastErr = err;
      if (i < retries - 1) await sleep(2000); // 延时2s重试
    }
  }
  throw lastErr;
}
```

将 Task 5 的 `Api.fetchCourses` / `Api.fetchResources` 内部调用改为 `fetchWithRetry`。

- [ ] **Step 2: 缓存损坏自愈确认**

`Store.load()` 已通过 `Logic.parseCache` 兜底（非法 JSON → 空缓存），确认 `Store.clear()` 可在面板暴露"清空缓存"入口，或在 `onScanClick` 捕获到缓存异常时提示重置。

- [ ] **Step 3: 接口失效提示**

在 `onScanClick` 的 catch 中，对非 `AUTH_EXPIRED` 且连续失败的错误，提示"接口可能已变更，请在控制台查看详情"。

- [ ] **Step 4: 验证 + 提交**

Run: `npm run build`；浏览器验证 401 场景提示与重试日志。
```bash
git add src/app.js
git commit -m "feat: 容错加固（重试/自愈/失效提示）"
```

---

### Task 10: 端到端验证 + 发布准备

**Files:**
- Create: `README.md`
- Modify: `src/app.js`（完善元数据）

**Interfaces:**
- Consumes: Task 1-9 全部产出

- [ ] **Step 1: 按设计文档测试清单验证**

逐项在浏览器验证并记录：
1. 首次运行（清空缓存）完整扫描；
2. 再次运行无新增 → "无新增课件"；
3. 新增课程 → 仅展示新课程课件；
4. 原课程新增课件 → 只展示新增课件；
5. 图片流课件 → 禁用勾选 + 悬停提示；
6. 多页课程列表 → 分页全量抓取。

- [ ] **Step 2: 完善元数据**

`src/app.js` 头部补充 `@homepageURL`、`@updateURL`（raw 链接）、`@license MIT`；`@version` 提升到 `1.0.0`。

- [ ] **Step 3: 编写 README.md**

内容：功能说明、安装方法（Tampermonkey → 新建脚本 → 粘贴）、使用步骤（登录 → 打开页面 → 点击悬浮按钮）、合规声明、已知限制（图片流课件无法下载源文件、接口变更风险）。

- [ ] **Step 4: 最终构建与提交**

Run: `npm test && npm run build`
```bash
git add README.md src/app.js
git commit -m "release: v1.0.0 发布准备"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计文档各节 → 任务映射：接口调研(T1)、脚手架(T2)、Store(T3)、类型识别+增量(T4)、Api(T5)、Scanner(T6)、UI(T7)、下载(T8)、容错(T9)、测试+发布(T10)。防风控策略在 T5(500ms分页)/T6(800ms)/T8(800ms) 落实。✅
- **占位符**：Task 1 产出接口契约后，Task 5 的 API 常量与映射函数才有真实值；计划中已用「依据 docs/apis.md 实际抓包结果」显式标注，属依赖而非占位。✅
- **类型一致**：`diffCourses` 返回结构在 T4/T6/T7 三处使用一致（`addedResources`/`addedCourseCount`/`addedResourceCount`）；`classifyResource` 返回枚举在 T4/T6 一致。✅
