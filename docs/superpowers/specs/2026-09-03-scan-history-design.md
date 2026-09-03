# 扫描历史（一级「历史」可回看/重下任意一次扫描）— 设计文档

> 日期：2026-09-03
> 分支：`feature/scan-history`（基于 master @ 8b56475，含 v1.5.0）
> 目标产物：油猴脚本 `rainclassroom-ppt-downloader.user.js`（@version 1.5.0 → 1.6.0）

## 背景与目标

浏览窗口只能处理「最近一次扫描会话」的新增（`browseNewKeys` 会话级、窗口关闭即失）。用户希望能**按次回看历史扫描**：每次有新增的扫描留档，一级入口「历史」浏览记录，点开某条即可按课程分组查看/勾选/下载该次新增文件——交互与现有「选中新增」「文件列表」版块一致。

## 已确认决策

| 决策点 | 结论 |
|--------|------|
| 记录粒度 | **新增文件**快照（含所属课程/班级），历史二级可逐文件勾选下载 |
| 记录时机 | **有新增才**写入一条（无新增不记） |
| 容量 | 保留最近 **100** 条，超出自动丢弃最旧 |
| 清空 | 设置「清空缓存」**一并清空**历史 |
| 存储 | 独立 GM key `rcppt_history_v1`，与课件缓存 `rcppt_cache_v1`（version=1 严格 parseCache）解耦，不动缓存 schema |

## 方案

### 1. 纯逻辑（`src/logic.js`，可单测）
- `emptyHistory()` / `parseHistory(raw)`（容错，脏条目丢弃，重算 fileCount/courseCount）/ `serializeHistory(h)`
- `appendHistory(h, record)`：新记录 unshift 到最前，截断至 `HISTORY_MAX=100`
- `snapshotHistoryRecord(addedResources, ts)`：diff → `{ts, files[], fileCount, courseCount}`，**裁剪 leafInfo 等大字段**；无有效新增返回 `null`
- 记录 file：`{courseId,classroomId,courseName,className, resource:{resourceId,name,type,url}}`

### 2. 记录钩子（`src/app.js`）
- `History` Store 仿 `Store`（GM 读写）
- `scanAndRefresh` 成功且 `diff.addedResources` 非空 → `History.save(appendHistory(load(), snapshotHistoryRecord(...)))`
- `onClearCache` 追加 `History.clear()`

### 3. UI（`src/app.js`）
- 把 v1.5.0 聚合视图 `renderNewFiles` 提炼为通用 `renderFileList({title,files,emptyText,back})`（分组 + 文件行 + 默认全勾 + 复用文件级 `onDownloadSelectedFiles`）
- `renderNewFiles()` 变薄封装（数据源 `collectNewFiles`，行为不变）
- 一级 `renderCourses` 顶栏新增「历史」按钮 → `renderHistory()`
- `renderHistory()`：记录列表（时间 + 「新增 N 个文件 · M 门课」，新在前，可点行）
- `renderHistoryFiles(rec)`：复用 `renderFileList`（`back: renderHistory`），记录即快照、独立于当前缓存
- 新增 `formatTs(ts)`（本地 YYYY-MM-DD HH:mm，pad 补零）

### 4. 版本 / 文档
- `@version` 1.5.0 → 1.6.0（app.js / package.json / 产物）
- README「功能特性」「使用教程」补扫描历史；本设计文档入库

## 测试与验证
- `tests/history.test.js`：parse 容错/脏条目、append 新在前 + 封顶 100、snapshot 裁剪与计数、空/脏输入 → null
- 回归：`npm test` 全绿、`npm run build` 产物与源码一致、@version 1.6.0
- Playwright UI 冒烟（file:// + GM/API 桩）：两次扫描两次留档（时间/数量、新的在前）→ 点开旧记录仅列出该次文件（不混入新记录）且默认勾选 → mock 下载计数只含该次文件；「选中新增」/「全选」/二级回归不变；「清空缓存」历史清空

## 风险与边界
- 历史存文件快照；内容被平台移除时下载按既有 per-file 失败计数，不中断
- 裁剪字段 + 100 条上限控制 GM 存储增长
- 不动缓存 version / parseCache，存量用户课件快照不受影响
