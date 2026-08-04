# 设计：图片型课件 → 前端合成单个 PDF（完全替换打印页/CDP）

> 日期：2026-08-04　分支：`feature/frontend-slides-pdf`　版本：1.2.0
> 上一版本：1.1.0（二级浏览窗口，已合并 master）

## 1. 背景与问题

图片型课堂 PPT（`type: 'img'`）无原始 PPT/PDF 文件，只有分片图片（`docs/apis.md §6`）。当前下载走 `Print.exportPdf`（`src/app.js`）：

1. API 懒加载链拿 `slideList[]`（每项 `cover` = 带签名 `e=`/`token=` 的图片 URL）。
2. 写 `rain_print` 到 localStorage → `window.open('/web/print')` → 打印页渲染全部封面。
3. CDP `Page.printToPDF` 全自动（需 Chrome 带 `--remote-debugging-port=9222`），否则 `win.print()` 半自动。

用户报告两个痛点：

- **不能完全自动化**：无 CDP 时回退 `win.print()`，需手动"另存为"；CDP 本身要求用户用特殊参数启动 Chrome。
- **白色空白页**：打印页固定等 2500ms 就 `printToPDF`，图片未加载完（或签名过期）→ 白页。

## 2. 可行性验证（2026-08-04 实机探测，Playwright 复用登录态）

封面 URL 形如 `https://changjiang-private-qn.yuketang.cn/slide/49467573/cover256_*.jpg?e=...&token=...`（跨域私有 CDN）。实测：

| 请求方式 | 结果 | 结论 |
|---|---|---|
| `<img src={cover}>` | ✅ 1280×720 加载成功 | 封面有效，16:9 JPEG |
| `fetch(cover, {mode:'cors', credentials:'omit'})` | ✅ 200 + `type:'cors'` | **CDN 允许跨域读取字节**（无需凭据，token 在 URL） |
| `<img crossOrigin='anonymous'>` + `canvas.toDataURL` | ✅ 返回 JPEG base64 | canvas 不污染，可作兜底 |
| `fetch(cover, {credentials:'include'})` | ❌ `TypeError: Failed to fetch` | 仅带凭据时被 CORS 拦——**显式 `credentials:'omit'` 即可** |

**结论：前端直接 fetch 封面字节可行，方案成立。** 且直接 fetch 拿到的是完整字节（天然"完全加载"），根治白页。

## 3. 方案（已批准）

**完全替换** `Print` 模块的图片下载路径：不再打开 `/web/print`、不再用 CDP/`win.print()`；改为前端 `fetch` 封面 → 手写极简 PDF 写入器合成单个 PDF → Blob 下载。**零新增运行时依赖、零弹窗、零外部 Chrome**。直链类型（pdf/pptx）下载路径不动。

## 4. 架构与组件

```
下载图片型课件（img）
  ├─ 1. API 懒加载链（保留现有 Api.fetchLeafInfo/fetchReview/fetchPpt）→ slideList[]
  ├─ 2. fetchSlidePages(slideList, onProgress)（新增，app.js）
  │      并发池（上限 5）fetch(cover, {mode:'cors', credentials:'omit'}) → bytes
  │      ├─ blob.type==='image/jpeg' → Logic.jpegDimensions(bytes) 取尺寸，直嵌（无损、快）
  │      └─ 其他（png/webp…）→ Image 解码 → canvas → toBlob('image/jpeg', 0.92) 归一化
  │      每页 await 完整加载；进度 onProgress(done, total)「拉取图片 i/N」
  ├─ 3. Logic.buildSlidesPdf(pages)（新增纯函数，logic.js）→ PDF Uint8Array
  │      页尺寸统一 = 第一个成功页的 width×height；其余页按比例缩放居中铺白底
  └─ 4. Blob 下载（复用 triggerDownload 的 a[download] 思路）→ {sanitize(name)}.pdf
```

### 新增组件

| 组件 | 位置 | 说明 |
|---|---|---|
| `Logic.buildSlidesPdf(pages)` | `src/logic.js` | 手写极简 PDF 写入器。输入 `[{bytes: Uint8Array, width, height}]`（成功页），输出 PDF `Uint8Array`。纯函数，**可单测** |
| `Logic.jpegDimensions(bytes)` | `src/logic.js` | 解析 JPEG SOF（Start of Frame）取宽高（~25 行）。非 JPEG/截断抛错。**可单测** |
| `Logic.sanitizeFilename(name)` | `src/logic.js` | 过滤 `\ / : * ? " < > |` 为下划线。**可单测** |
| `fetchSlidePages(slideList, onProgress)` | `src/app.js` | 并发池拉取 + 逐页失败隔离 + 格式双路径归一化。返回 `{ pages: [{bytes,width,height}], failed: number }`（仅成功页进 `pages`） |
| `exportSlidesPdf({classroomId, leafId, name})` | `src/app.js` | 编排：懒加载链 → fetchSlidePages → buildSlidesPdf → 下载 |

### 修改/删除

- `Print` 模块（`src/app.js`）：删除 `cdpAvailable`、`cdpPrintToPdf`；`exportPdf` 改名/改体为 `exportSlidesPdf`。
- `uvIdFromCookie`：**保留**（懒加载链仍需 uv_id）。
- `downloadFiles`（`src/app.js:536`）：`r.type==='img'` 分支改调 `exportSlidesPdf`，其余不动。

## 5. 数据流与错误处理

- **逐页失败隔离**：`fetchSlidePages` 返回 `{pages, failed}`——某页 fetch/解码失败 → 记入 `failed`，跳过该页继续（PDF 页数 = 成功页数）；`failed === slideList.length`（全失败）→ 抛错，行标"失败"。
- 行状态提示：`拉取图片 i/N` → `合成 PDF` → `✓`；有失败页时追加 `（N 页失败）`。
- **fetch 超时**：复用现有 `AbortController` 20s 模式，失败重试一次（间隔 1s）。
- **登录失效**：API 链 `code 401` 仍走 `AUTH_EXPIRED` 全局提示（`scanAndRefresh`/`exportSlidesPdf` 内沿用现有语义）。
- **页尺寸统一**：`buildSlidesPdf` 以 `pages[0]`（第一个成功页）为基准 `pageW/pageH`；后续页尺寸相同则满版 `W 0 0 H 0 0 cm /Im0 Do Q`，不同则 `scale=min(W/iw, H/ih)` + 居中偏移（铺白底，不拉伸变形）。

## 6. PDF 写入器格式要点（`buildSlidesPdf`）

- 对象布局：`Catalog → Pages → (Page + Contents + Image XObject)*N`，每页：`MediaBox [0 0 pageW pageH]`、`Contents`（`q … cm /Im0 Do Q`）、图像 XObject `/Subtype /Image /Width iw /Height ih /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`，JPEG 字节原样进 stream。
- **xref 偏移必须字节精确**：用 `Uint8Array` 拼接（JPEG 含任意字节值，禁止字符串拼接），逐段记录偏移生成 xref 表 + trailer + `%%EOF`。
- 输出文件以 `%PDF-1.4\n` 开头，`%%EOF` 结尾。

## 7. 测试

### 单元测试（`node --test`，与现有 tests/*.test.js 同构）

- `buildSlidesPdf`：
  - 1 页：`%PDF-` 头、含 `/DCTDecode`、页数为 1、`MediaBox` = 传入尺寸、xref 内各偏移指向的 `N 0 obj` 正确、`%%EOF` 结尾。
  - 2 页不同尺寸：页尺寸统一为 pages[0]，第二页含 `cm` 缩放/居中参数。
- `jpegDimensions`：内嵌已知小 JPEG（如 8×6）→ 返回 `{width:8, height:6}`；非 JPEG 魔数 / 截断 → 抛错。
- `sanitizeFilename`：`a/b\c:d*e?f"g<h>i|` → 非法字符全替换。

### 端到端（Playwright 复用登录态，仓库惯例）

- 对一门含图片型课件的课，注入构建产物 → 勾选下载 → 校验触发下载的 `.pdf`：
  - 文件非空、`%PDF-` 头、页数 = 成功页数（≥ slideCount − 失败页）。
  - 用本机 `pypdfium2`（已有）渲染首页为 PNG → 非空白像素占比 > 阈值（直接验证白页 bug 已修复）。
- 回归：`npm test` 全绿（现有 21 + 新增）。

## 8. 分支与发布

- 分支：`feature/frontend-slides-pdf`（自 master，已建）。
- 版本：`@version` 1.1.0 → **1.2.0**；README 图片型下载描述同步更新（去掉"打印导出 PDF/CDP"表述）。
- 流程：SDD——本 spec → 实现计划 → 任务实现（纯函数单测先行）→ 整分支审查 → 合并回 master（仓库 PUBLIC，合并/推送前用户确认）。

## 9. 明确不做（YAGNI）

- 不做 ZIP 图片包 / pdfkit 引入（已选手写 PDF 写入器）。
- 不做打印页回退（已选完全替换）。
- 不做自定义排版/水印/页眉（保持"每页一张原图"）。
- 不做跨 PPT 合并为多 PPT 一个 PDF（每张图片型课件各自一个 PDF，沿用现行为）。
