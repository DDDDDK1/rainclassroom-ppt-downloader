# 一级课程行内展开(下拉)浏览文件 — 设计文档

> 日期：2026-09-03
> 分支：`feature/course-inline-expand`（基于 master @ e693bcb，含 v1.6.0）
> 目标产物：油猴脚本 `rainclassroom-ppt-downloader.user.js`（@version 1.6.0 → 1.7.0）

## 背景与目标

现状一级点课程名会**跳转**独立二级全屏文件面板（`renderFiles`）。用户希望改为**行内下拉**：点击课程不再跳转，直接在其下展开该课文件；展开的文件行样式与「选中新增」聚合视图一致（类型徽标 + 名称 +「新」+ 勾选框）。浏览窗口由「两面板切换」变为「单页树形列表」。

## 已确认决策

| 决策点 | 结论 |
|--------|------|
| 展开文件行 | 带勾选框、可直接勾选用于下载；课程整行勾选仍 = 整门下载 |
| 旧独立二级 | **移除** `renderFiles`（其能力被行内展开取代；历史/「选中新增」等聚合入口不变） |
| 展开策略 | **可多门同时展开**（各课独立，展开保留已勾选态） |
| 下载语义 | 一级「下载选中」= 整门 + 行内单文件，经 `collectSelection(courseRefs+resourceRefs)` 去重 |

## 方案

### UI（`src/app.js`）
- `makeFileRow(f, {prechecked, showNew})`：抽出**文件行构造器**（checkbox/类型徽标/名称/「新」/dataset + `dataset.courseId`），`renderFileList` 与行内展开共用。
- `renderCourses`：课程行加 `▸/▾`（`.rcppt-caret`），行下挂 `.rcppt-course-files` 子容器（默认 `display:none`）；点课程行（非勾选框）→ `toggleCourseExpand`：首展懒构建该课文件行（过滤 `other`，空课显示「此课堂无文件」），之后仅切 `display` —— 保留勾选态、可多开。
- **移除** `renderFiles` 函数与跳转调用（`grep` 无残留引用）。
- `onDownloadSelectedCourses`：整行勾选课程 → `courseRefs`（`>.rcppt-course > input` 直选）；行内文件勾选 → `resourceRefs`（`.rcppt-course-files` 内，读 dataset.courseId/classroomId/leafId）；`collectSelection` 合并去重 → `downloadFiles`。
- 「全选」「选中新增」「历史」「renderFileList.onDownloadSelectedFiles」保持不变；全选会同时勾课程与已展开文件。

### CSS（`ensureStyles`）
`.rcppt-course-files`（缩进+左边线，`.open` 才显示）、`.rcppt-caret`、`.rcppt-empty-inline`。

### 版本 / 文档
`@version` 1.6.0 → 1.7.0（app.js/package.json/产物）；README 使用教程第 4/5 步更新为行内展开说明；本设计文档入库。

## 测试与验证
- 回归 `npm test` 全绿；`npm run build` 产物一致、@version 1.7.0。
- Playwright UI 冒烟（file:// + GM/API 桩）：默认收起无跳转（标题不变）；点课程行展开/收起、可多开；行内勾单文件「下载选中」只下该文件；勾整行课程=整门；两者同勾去重；勾选框点击不触发展开；全选/「选中新增」/历史回归。

## 风险与边界
- **checkbox 查询作用域**：一级面板同时含课程行与展开文件行，读取必须按 role class 区分（`>.rcppt-row.rcppt-course > input` / `.rcppt-course-files .rcppt-row input`），避免误读。
- 整行勾选 + 行内个别勾选组合 = 整门优先（collectSelection 课程展开全量），本版不做「整门减个别」三态。
- 重新扫描整体重渲染 → 收起并重置勾选（可接受）。
