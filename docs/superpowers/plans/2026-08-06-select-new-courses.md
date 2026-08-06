# 一键选中新增课程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在浏览窗口的两级操作栏各新增「选中新增」按钮，一键勾选所有新增课程（第一级）/ 该课程所有新增文件（第二级），下载行为不变。

**Architecture:** 纯判定逻辑 `courseHasNew(course, newKeys)` 抽入 `src/logic.js`（UMD、可单测）；两处按钮在 `src/app.js` 的 `renderCourses` / `renderFiles` 操作栏实现，复用现有 `browseNewKeys` + `keyOf` 判定（与「+N 新」/「新」徽标同源），勾选方式与「全选」一致（`checked=true` + `dispatchEvent('change')` 触发选中高亮）。

**Tech Stack:** 原生 JavaScript；Node 内置 `node:test` 单测；`npm run build` 合并 `src/logic.js` + `src/app.js` 生成发布产物。

## Global Constraints

- 最终产物 `rainclassroom-ppt-downloader.user.js`：UTF-8 无 BOM，元数据连续置顶
- `@match https://changjiang.yuketang.cn/*`；`@grant` 仅 `GM_setValue`/`GM_getValue`；无外部库、无 `@require`
- 中文 UI；无 eval/new Function；面板内容用 `textContent` 渲染外部数据
- 增量判定唯一键 = `courseId + classroomId + resourceId`（`keyOf` 格式 `courseId:classroomId:resourceId`）
- 「新增」判定数据源 = 会话级 `browseNewKeys`（Set，元素为上述唯一键），与徽标渲染同一数据源
- 文案统一「选中新增」；两处按钮均置于操作栏「全选」旁
- 下载行为零改动：勾选课程 → `onDownloadSelectedCourses`（整课全部课件）；勾选文件 → `onDownloadSelectedFiles`
- 版本：`@version` 1.3.0 → 1.4.0；package.json `version` 同步
- 测试运行：`node --test tests/`；构建：`npm run build`
- 派发 subagent 一律用 haiku 模型

---

### Task 1: `courseHasNew` 纯逻辑 + 单测（TDD）

**Files:**
- Modify: `src/logic.js`（`collectSelection` 之后新增函数，并加入 return 导出）
- Test: Create: `tests/course-has-new.test.js`

**Interfaces:**
- Consumes: 无（纯函数，零依赖）
- Produces: `RCLogic.courseHasNew(course, newKeys) → boolean`
  - `course`: `{ courseId, classroomId, resources: Array<{ resourceId, ... }> }`（缓存课程对象）
  - `newKeys`: `Set<string>`，元素格式 `courseId:classroomId:resourceId`（与 `collectSelection` 内部 key 构造、app.js `keyOf` 完全一致）
  - 返回 `true` ⇔ `course` 合法且 `resources` 中至少一个的 key 命中 `newKeys`
  - 非法入参（`course` 为 null、`resources` 非数组、`newKeys` 非 Set）一律返回 `false`，不抛错

- [ ] **Step 1: 写失败测试**

创建 `tests/course-has-new.test.js`：

```js
// tests/course-has-new.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

// 与 app.js keyOf / logic.collectSelection 相同的 key 格式
function keyOf(course, resource) {
  return course.courseId + ':' + course.classroomId + ':' + resource.resourceId;
}

function makeCourse(overrides = {}) {
  return {
    courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
    resources: [
      { resourceId: 'r1', name: '第1章', type: 'img', url: null },
      { resourceId: 'r2', name: '第2章', type: 'img', url: null }
    ],
    scanTime: 1,
    ...overrides
  };
}

test('courseHasNew 部分新增 → true', () => {
  const course = makeCourse();
  const keys = new Set([keyOf(course, course.resources[0])]);
  assert.equal(L.courseHasNew(course, keys), true);
});

test('courseHasNew 全部新增 → true', () => {
  const course = makeCourse();
  const keys = new Set(course.resources.map((r) => keyOf(course, r)));
  assert.equal(L.courseHasNew(course, keys), true);
});

test('courseHasNew 无新增 → false', () => {
  const course = makeCourse();
  const keys = new Set(['c1:k1:r9']); // 无命中
  assert.equal(L.courseHasNew(course, keys), false);
});

test('courseHasNew 空课程（resources=[]）→ false', () => {
  const course = makeCourse({ resources: [] });
  const keys = new Set();
  assert.equal(L.courseHasNew(course, keys), false);
});

test('courseHasNew 非法入参不抛错 → false', () => {
  assert.equal(L.courseHasNew(null, new Set()), false);
  assert.equal(L.courseHasNew(makeCourse({ resources: null }), new Set()), false);
  assert.equal(L.courseHasNew(makeCourse(), null), false);
  assert.equal(L.courseHasNew(makeCourse(), 'not-a-set'), false);
});

test('courseHasNew 多教室同名课程只认本教室新增', () => {
  const course = makeCourse({ classroomId: 'k1' });
  const other = { courseId: 'c1', classroomId: 'k2', resources: [{ resourceId: 'r1' }] };
  const keys = new Set([keyOf(other, other.resources[0])]); // c1:k2:r1
  assert.equal(L.courseHasNew(course, keys), false); // 不误判 k1
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/course-has-new.test.js`
Expected: FAIL（`L.courseHasNew is not a function`）

- [ ] **Step 3: 实现 `courseHasNew`**

在 `src/logic.js` 的 `collectSelection` 函数之后新增：

```js
  // 课程是否"新增课程"：该课程下至少一个资源命中会话级 newKeys
  // key 格式与 collectSelection / app.js keyOf 一致：courseId:classroomId:resourceId
  function courseHasNew(course, newKeys) {
    if (!course || !Array.isArray(course.resources) || !(newKeys instanceof Set)) return false;
    return course.resources.some(
      (r) => r && newKeys.has(`${course.courseId}:${course.classroomId}:${r.resourceId}`)
    );
  }
```

在 return 对象中导出（`collectSelection` 之后加入）：

```js
    collectSelection,
    courseHasNew,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/course-has-new.test.js`
Expected: PASS（6/6）

- [ ] **Step 5: 提交**

```bash
git add src/logic.js tests/course-has-new.test.js
git commit -m "feat: courseHasNew 纯逻辑——课程级「新增」判定（一键选中新增课程的基础）"
```

---

### Task 2: 第一级课程列表「选中新增」按钮

**Files:**
- Modify: `src/app.js`（`renderCourses` 底部操作栏，`btnSelectAll` 定义之后、`bar.append` 之前）
- Build: `rainclassroom-ppt-downloader.user.js`（`npm run build` 重新生成）

**Interfaces:**
- Consumes: Task 1 的 `Logic.courseHasNew(course, browseNewKeys)`；现有 `browseCache`（课程数组，checkbox `dataset.index` 指向其下标）、`browseNewKeys`
- Produces: 第一级操作栏出现「选中新增」按钮，点击后勾选所有新增课程行

- [ ] **Step 1: 在 `renderCourses` 操作栏加按钮**

`src/app.js` `renderCourses` 中，`btnSelectAll` 定义与其 `addEventListener` 之后、`bar.append(btnSelectAll, btnDownload, btnClose)` 之前，插入：

```js
    const btnSelectNew = document.createElement('button');
    btnSelectNew.textContent = '选中新增';
    btnSelectNew.addEventListener('click', () => {
      panel.querySelectorAll('.rcppt-row.rcppt-course input[type=checkbox]').forEach((cb) => {
        const course = browseCache.courses[Number(cb.dataset.index)];
        if (course && Logic.courseHasNew(course, browseNewKeys)) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change')); // 触发选中高亮，与「全选」一致
        }
      });
    });
```

并将 `bar.append(btnSelectAll, btnDownload, btnClose)` 改为 `bar.append(btnSelectAll, btnSelectNew, btnDownload, btnClose)`。

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 成功生成 `rainclassroom-ppt-downloader.user.js`，无报错。

- [ ] **Step 3: Playwright 验证（mock 扫描，两轮验证部分新增）**

用 playwright MCP 或 `node_repl` 加载构建产物；mock GM API 与三个接口（`courses/list`、`classrooms/`、`chapter`），首轮 2 门课、二轮 3 门课验证「选中新增」只勾选新增课程。核心脚本：

```js
// 伪代码骨架（node_repl + playwright）：
const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  const store = new Map();
  window.GM_getValue = (k, d) => store.has(k) ? store.get(k) : d;
  window.GM_setValue = (k, v) => store.set(k, v);
  let round = 1; window.__setRound = (r) => { round = r; };
  const mkCourse = (cid, kid, name, cls) => ({ classroom_id: kid, course: { id: cid, name }, name: cls, teacher: { name: 'T' }, role: 5 });
  window.fetch = async (url) => {
    const u = String(url);
    let body;
    if (u.includes('/v2/api/web/courses/list')) {
      const list = round === 1
        ? [mkCourse('ca', 'ka', '高数', '高数A班'), mkCourse('cb', 'kb', '英语', '英语A班')]
        : [mkCourse('ca', 'ka', '高数', '高数A班'), mkCourse('cb', 'kb', '英语', '英语A班'), mkCourse('cc', 'kc', '物理', '物理A班')];
      body = { errcode: 0, data: { list } };
    } else if (u.includes('/v2/api/web/classrooms/')) {
      body = { errcode: 0, data: { course_sign: 's', uv_id: '1' } };
    } else if (u.includes('/mooc-api/v1/lms/learn/course/chapter')) {
      body = { data: { course_chapter: [{ section_leaf_list: [{ id: 'leaf' + round, name: '课件', leaf_type: 8 }] }] } };
    } else body = { errcode: 0, data: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ path: 'rainclassroom-ppt-downloader.user.js' });
await page.click('.rcppt-btn');        // 打开浏览窗口
await page.click('.rcppt-scan');       // 第一轮扫描
await page.waitForSelector('.rcppt-row.rcppt-course');
await page.click('text=选中新增');
let checked = await page.$$eval('.rcppt-row.rcppt-course input[type=checkbox]', els => els.map(e => e.checked));
// 断言 1：第一轮 2 门课全新增 → [true, true]
// 第二轮：新增物理 → 只勾选新增课程
await page.evaluate(() => window.__setRound(2));
await page.click('.rcppt-scan');
await page.waitForSelector('.rcppt-row.rcppt-course');
await page.click('text=选中新增');
checked = await page.$$eval('.rcppt-row.rcppt-course input[type=checkbox]', els => els.map(e => e.checked));
// 断言 2：仅第 3 门（物理）为 true
```

Expected: 断言 1 与断言 2 均通过（第一轮 `[true, true]`；第二轮 `[false, false, true]`）；勾选行带 `selected` 高亮 class。

- [ ] **Step 4: 提交**

```bash
git add src/app.js rainclassroom-ppt-downloader.user.js
git commit -m "feat: 浏览窗口第一级新增「选中新增」按钮——一键勾选全部新增课程"
```

---

### Task 3: 第二级文件列表「选中新增」按钮

**Files:**
- Modify: `src/app.js`（`renderFiles` 底部操作栏，`btnSelectAll` 定义之后、`bar.append` 之前）
- Build: `rainclassroom-ppt-downloader.user.js`

**Interfaces:**
- Consumes: 现有 `course`（`renderFiles` 闭包参数）、`browseNewKeys`、`keyOf(course, resource)`
- Produces: 第二级操作栏出现「选中新增」按钮，点击后勾选该课程所有新增文件行

- [ ] **Step 1: 在 `renderFiles` 操作栏加按钮**

`src/app.js` `renderFiles` 中，`btnSelectAll` 定义与其 `addEventListener` 之后、`bar.append(btnSelectAll, btnDownload, btnClose)` 之前，插入：

```js
    const btnSelectNew = document.createElement('button');
    btnSelectNew.textContent = '选中新增';
    btnSelectNew.addEventListener('click', () => {
      panel.querySelectorAll('.rcppt-row input[type=checkbox]').forEach((cb) => {
        if (cb.disabled) return;
        const resource = course.resources[Number(cb.dataset.index)];
        if (resource && browseNewKeys.has(keyOf(course, resource))) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change')); // 触发选中高亮，与「全选」一致
        }
      });
    });
```

并将 `bar.append(btnSelectAll, btnDownload, btnClose)` 改为 `bar.append(btnSelectAll, btnSelectNew, btnDownload, btnClose)`。

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 成功生成产物，无报错。

- [ ] **Step 3: Playwright 验证（复用 Task 2 脚本 + 第二级断言）**

复用 Task 2 的 mock 环境。点开某一新增课程进入第二级 → 点「选中新增」→ 断言仅带「新」徽标的文件行被勾选；对无新增的课程进入第二级 → 点「选中新增」→ 断言无行被勾选。

Expected: 新增文件的行 `checked === true` 且带 `selected` class；非新增课程内无任何勾选。

- [ ] **Step 4: 提交**

```bash
git add src/app.js rainclassroom-ppt-downloader.user.js
git commit -m "feat: 浏览窗口第二级新增「选中新增」按钮——一键勾选该课程全部新增文件"
```

---

### Task 4: 版本号 + README + 全量回归

**Files:**
- Modify: `src/app.js`（元数据 `@version`）
- Modify: `package.json`（`version`）
- Modify: `README.md`（「✨ 功能特性」区增补）
- Build: `rainclassroom-ppt-downloader.user.js`

- [ ] **Step 1: 版本号 1.3.0 → 1.4.0**

`src/app.js` 第 4 行：`// @version      1.3.0` → `// @version      1.4.0`
`package.json`：`"version": "1.3.0"` → `"version": "1.4.0"`

- [ ] **Step 2: README 增补功能特性**

在 `README.md`「✨ 功能特性」的「增量检测」条目后追加一条（`textContent` 无关，README 纯文案）：

```markdown
- **一键选中新增**：浏览窗口内「选中新增」一键勾选所有新增课程（或某课程全部新增文件），配合「下载选中」批量下载，无需逐个手动勾选。
```

- [ ] **Step 3: 构建 + 全量测试**

Run: `npm run build` && `node --test tests/`
Expected: 构建成功；全部现有测试 + 新增 `course-has-new.test.js` 全绿（Task 1 之后为 6 条新增，总量 = 既有 + 6）。

- [ ] **Step 4: 提交**

```bash
git add src/app.js package.json README.md rainclassroom-ppt-downloader.user.js
git commit -m "release: v1.4.0 一键选中新增课程"
```
