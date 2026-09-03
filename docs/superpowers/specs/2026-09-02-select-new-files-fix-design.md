# 修复：一级「选中新增」精确到新增文件 — 设计记录

> 日期：2026-09-02
> 分支：master（直接修复，v1.4.0 → v1.5.0）
> 关联：`docs/superpowers/specs/2026-08-06-select-new-courses-design.md`（v1.4.0 原设计，一级为「勾选整行新增课程 + 整门下」——本次按用户报告作废该一级语义）

## 根因

v1.4.0 一级「选中新增」用 `courseHasNew` **勾选整行课程**，一级下载 `onDownloadSelectedCourses` 将勾选课程展开为该课**全部**资源 → 存量课程新增几件时会把旧件连带下载。增量判定粒度是**文件**（`browseNewKeys`），一级勾选/下载粒度是**课程**，二者错配。

## 决策

一级「选中新增」改为**文件级**：点击后打开「新增课件」聚合列表（数据源 `collectNewFiles(browseCache, browseNewKeys)`，与徽标同源），按课程分组、每行预勾选，底部「下载选中」走既有文件级链路 `onDownloadSelectedFiles` —— **只下载新增件**。

- 手动整行勾选 / 「全选」= 整门下载（不变）
- 二级「选中新增 / 下载」= 文件级（不变）

## 改动

| 文件 | 变更 |
|------|------|
| `src/logic.js` | +`collectNewFiles(cache,newKeys)`（复用 `collectSelection`）；−`courseHasNew`（改后无引用，删除死代码） |
| `src/app.js` | 一级按钮改调 `renderNewFiles()`；新增 `renderNewFiles()` 聚合视图；`ensureStyles` +`.rcppt-group`；下载核心/`onDownloadSelectedFiles`/二级零改动 |
| `tests/` | +`collect-new-files.test.js`（6 条）；−`course-has-new.test.js` |
| `README.md` / `package.json` / `@version` | 语义描述更新；1.4.0 → 1.5.0 |

## 验证

`npm test` 全绿；`npm run build` 成功、产物与源码一致（`git diff` 空）；产物 `@version 1.5.0`、含 `collectNewFiles`/`renderNewFiles`、无 `courseHasNew`。
