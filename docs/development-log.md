# 开发日志（Development Log）

> 面向后续维护者与 AI agent 的项目演进记录，覆盖 v1.0.0 → v1.2.0 的版本里程碑、关键决策与已知待办。
> 接口契约见 `docs/apis.md`；各版本设计与实现计划见 `docs/superpowers/plans/` 与 `docs/superpowers/specs/`。
> 原始 SDD 台账位于 `.superpowers/sdd/`（git-ignored，可能被清理）——本文件为入库的权威演进记录。

## 版本里程碑

| 版本 | 关键提交 | 主要内容 |
|------|---------|---------|
| v1.0.0 | `fb3f6f1` 发布准备 → `7d6c759` 发布收尾 | 初版可用：全量扫描 + 增量检测（本地缓存）、直链下载、**图片流走打印页导出 PDF**（CDP 全自动 / `window.print()` 半自动） |
| v1.1.0 | `9fb05cf` | **二级浏览窗口**统一中心：两级列表 / 行高亮选中 / 窗口内扫描 / 清空缓存 |
| v1.2.0 | `4177754` → `a772371` | **图片型课件改为前端合成 PDF**，删除打印页 / CDP 路径；`buildSlidesPdf` 手写 PDF 写入器 |

> 当前 master `@version 1.2.0`；脚本已发布 Greasy Fork（脚本 ID `589891`）。
> ⚠️ 仓库 PUBLIC，任何推送 / 合并 / PR 操作前需用户确认。

## 架构与代码

- `src/app.js` — 用户脚本主逻辑（IIFE，浏览器运行；`@match changjiang.yuketang.cn/*`）
- `src/logic.js` — 纯函数逻辑：`Store` 缓存（`parseCache` / `upsertCourse`）、`diffCourses` 增量对比、`classifyResource` 类型识别、`collectSelection`、`sanitizeFilename`、`jpegDimensions`、`buildSlidesPdf`（PDF 合成）；经 `window.RCLogic` 暴露
- `build.js` — 构建：把 `logic.js` 注入 `app.js` 的 `/* __LOGIC__ */` 标记，产出单文件 `rainclassroom-ppt-downloader.user.js`
- `tests/` — Node 内置 test runner（`node --test`），纯函数单测，当前 **30/30 全绿**
- 版本号**硬编码**在 `src/app.js` 头部（`build.js` 不读 `package.json`）；`package.json` 版本仅一致性
- 运行时依赖：**零**（无第三方库）；`GM_setValue / GM_getValue` 存缓存

## 关键决策（ADR 摘要）

### 1. 增量判定唯一键 = courseId + classroomId + resourceId（v1.0.0）
- 初版按 `courseId + resourceId`；真实数据 45 课程条目 → 26 唯一 courseId，证明**不同教室的同门课共享 courseId**，多教室场景增量判定会失效。
- 修复：缓存与 `diffCourses` 均按三键唯一化，资源级携带 classroomId（用户批准偏离计划逐字文本）。

### 2. 图片流导出：打印页 / CDP → 前端合成 PDF（v1.2.0，最重要）
- **旧方案**（v1.0.0–v1.1.0）：打开 `/web/print` 打印页 → CDP（Chrome `--remote-debugging-port`）或 `window.print()` 半自动导出。痛点：需手动开启调试端口、手动「另存为」、存在白页风险、Firefox 不支持。
- **新方案**（v1.2.0）：`fetch` 封面字节 → `Logic.buildSlidesPdf` 前端合成单个 PDF → Blob 触发下载。
  - CORS：`{ mode:'cors', credentials:'omit' }`（跨域私有 CDN 允许无凭据读取，token 在 URL；带凭据反而被拒）；20s 超时 + 失败重试一次；并发上限 5；逐页失败隔离。
  - `buildSlidesPdf` 为**手写 PDF 写入器**：Uint8Array 拼接保证 xref 偏移字节精确（**禁止字符串拼接 JPEG**）；JPEG 字节直嵌（`/Filter /DCTDecode`）；页尺寸统一为第一个成功页，异尺寸页等比缩放居中；文件名经 `sanitizeFilename`。
  - 约束：**零新增运行时依赖**，不引 pdf-lib 等。

### 3. 页序保序（v1.2.0，计划逐字代码有 bug，用户批准修复）
- 计划逐字代码 `pages.push` 按完成时序入序，**并发下载下页序被打乱**。修复：`fetchSlidePages` 按 `results[i]` 落位 + `filter(Boolean)`，并发但保序。

### 4. 401 处理（v1.0.0）
- 扫描中途登录失效应**立即中止整轮**并提示「登录已失效」：`fetchWithRetry` 对 401 不重试直接抛；per-course catch 首行 `if (err.code === 401) throw err;`（否则 401 被吞进 `failed[]`，所有课程被误标失败）。

### 5. 乱码根因（v1.0.0，README-only 修复）
- 源文件 / 构建产物均干净 UTF-8（0 U+FFFD）；但脚本经**无 `charset=utf-8` 声明的 HTTP 或 `file://`** 提供时，Chromium 编码检测按 GBK 误判 → mojibake（长江→闀挎睙，实测复现）。
- `// @charset UTF-8` 元数据实测无效。可靠路径：GitHub raw（`text/plain; charset=utf-8`）、Tampermonkey 编辑器粘贴（UTF-8）、或 **Greasy Fork 一键安装**（v1.2.0 起 README 首选）。

### 6. 发布与更新事实
- `@updateURL` 指向 `raw.githubusercontent.com/…/master/…user.js`；Greasy Fork 安装时由其改写为 `update.greasyfork.org`（更新不依赖 GitHub）。
- 教训：**master 产物版本需与 Greasy Fork 保持同步**——v1.2.0 发布时 master 曾落后为 1.1.0，GitHub raw 安装会拿到旧版（已消除，注意未来发布不要重蹈）。

## 工作流约定

- **所有 subagent 一律用 haiku 模型**（2026-08-04 用户指令，含任务审查与整分支审查；覆盖交接文档的 sonnet/opus 分级建议）。
- 本仓库采用 Subagent-Driven Development（SDD）：每任务派发实现者 subagent → 任务审查 → fix 循环（最多 5 轮）→ 整分支终审；台账在 `.superpowers/sdd/`。

## 已知待办（parked minors，可择机修复）

1. `fetchWithRetry` 不映射业务鉴权码（如 `errcode=50014`）为「登录已失效」——重试约 4s 后才以通用错误抛出。
2. 下载循环 per-row catch 无条件吞 401——会话过期后点「下载选中」每行仅标「失败」，无登录失效提示。
3. `normalizeSlidePage` 的 `getContext('2d')` 未判空——超大图 canvas 超限返回 `null` 抛 TypeError（被外层 catch 兜住标失败，可接受）。
4. 全失败场景日志三层叠加（每页 `console.warn` + `exportSlidesPdf` 抛错 + `downloadFiles` catch warn）。
5. 测试缺口：`jpegDimensions` SOF 截断分支、`buildSlidesPdf`「页面尺寸无效」分支、`sanitizeFilename(0/false)`、`diffCourses` 'other' 过滤路径。
6. `Object.assign(diff, { failed })` 原地改动（宜 `{ ...diff, failed }` 保持纯风格）。
7. 直链下载文件名可能缺扩展名（`a.download = name`）。
8. 失败课程跳过 `sleep(800)`（sleep 在 try 内，失败路径两课请求间隔趋近 0ms）。
9. `keepAlive` 永久覆写 `pushState` + MutationObserver 开销（功能正确，计划逐字）。
