# 一键选中新增课程 — 设计文档

> 日期：2026-08-06
> 状态：已确认
> 分支：`feature/select-new-courses`（基于 master @ 560d651）
> 目标产物：油猴脚本 `rainclassroom-ppt-downloader.user.js`（@version 1.3.0 → 1.4.0）

## 一、背景与目标

现状（master v1.3.0 二级浏览窗口）：扫描后，第一级课程列表对**有新增课件**的课程显示「+N 新」徽标，第二级文件列表对**新增文件**显示「新」徽标；底部操作栏的「全选」会勾选**所有**课程/文件（含无新增者）。

目标：增加**一键选中所有新增课程**的能力——即只勾选本次扫描**有新增内容**的课程，而不是全部课程。用户点「下载选中」即可批量下载这些新增课程的所有课件，无需逐个手动勾选。

### 已确认的需求决策

| 决策点 | 结论 |
|--------|------|
| 基础版本 | master v1.3.0（浏览窗口），从 master 创建新分支 |
| 选中粒度 | 第一级：勾选所有「新增课程」（带「+N 新」徽标）；第二级：勾选该课程所有「新增文件」（带「新」徽标） |
| 按钮文案 | 两处均「选中新增」，置于底部操作栏「全选」旁 |
| 下载行为 | **零改动**：沿用现有下载链路（勾选课程 = 该课全部课件；勾选文件 = 勾选的文件） |
| 新增判定 | 与「徽标渲染」同一数据源 `browseNewKeys`，二者天然一致 |
| 版本 | 新功能 → @version 1.4.0，package.json 同步 |

## 二、方案选择

**方案 A（已选）：两处新增「选中新增」按钮，不改下载语义**

- 第一级 `renderCourses` 操作栏「全选」旁加「选中新增」：点击后勾选所有带「+N 新」徽标的课程行；
- 第二级 `renderFiles` 操作栏「全选」旁加「选中新增」：点击后勾选该课程所有带「新」徽标的文件行；
- 判定逻辑复用现有 `browseNewKeys` + `keyOf`，与徽标渲染同源，无二义性；
- 下载走现有 `onDownloadSelectedCourses` / `onDownloadSelectedFiles`，不动下载链路。

**弃用方案：**

- 方案 B（每行加「选中」小按钮）：可逐个勾选，但违背"一键全部"诉求，按钮冗余。
- 方案 C（改下载语义——只下载新增课件）：与用户确认的"下载新增课程的所有课件"不符，且改动下载链路、风险面大。

## 三、改动范围

### 3.1 纯逻辑（`src/logic.js`，可单测）

新增课程级判定 helper：

```js
// 课程是否"新增课程"：该课程下至少一个资源是本次扫描新增的
function courseHasNew(course, newKeys) {
  return Array.isArray(course && course.resources) &&
    course.resources.some((r) => newKeys.has(keyOf(course, r)));
}
```

- `keyOf` 在 app.js 定义为 `` `${courseId}:${classroomId}:${resourceId}` ``，此处需同步一致（或作为参数传入前缀逻辑）。
- 文件级判定直接 `browseNewKeys.has(keyOf(course, resource))`，不另抽。

### 3.2 第一级课程列表（`src/app.js` `renderCourses`）

- 操作栏「全选」旁新增「选中新增」按钮；
- 点击：`panel.querySelectorAll('.rcppt-row.rcppt-course')` 遍历，对 `courseHasNew(course, browseNewKeys)` 为真的行勾选其 checkbox 并触发 `change`（保持选中高亮一致，与「全选」的实现方式相同）。

### 3.3 第二级文件列表（`src/app.js` `renderFiles`）

- 操作栏「全选」旁新增「选中新增」按钮；
- 点击：遍历本课程文件行，`browseNewKeys.has(keyOf(course, resource))` 为真则勾选该行 checkbox 并触发选中态。

## 四、测试策略

| 层级 | 手段 | 覆盖 |
|------|------|------|
| 纯逻辑单测 | `node --test`（tests/ 新增用例） | `courseHasNew`：无新增 / 部分新增 / 全部新增 / 空课程 / 非法入参（非数组 / null） |
| UI 行为 | Playwright 手动验证（app.js IIFE 未导出，沿用仓库先例） | 造缓存 → 开浏览窗口 → 点「选中新增」→ 断言第一级仅新增课程被勾选 + 高亮；进入新增课程 → 第二级仅新增文件被勾选 + 高亮 |
| 回归 | `npm run build` + 现有测试全绿 | 下载链路不受影响 |

## 五、合规与发布

- 不改接口、不新增权限（`@grant` 不变）；
- `@version` 1.3.0 → 1.4.0；package.json `version` 同步；
- README「功能特性」增补一键选中新增课程说明（可选，随实现提交）。
