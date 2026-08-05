# 设置版块 + 分类下载 + 无文件提示 — 设计文档

> 日期：2026-08-05
> 状态：已确认
> 分支：`feature/settings-categorized-download`（基于 master @ e76d491）
> 目标产物：油猴脚本 `rainclassroom-ppt-downloader.user.js`（@version 1.2.0 → 1.3.0）

## 一、背景与目标

现状：

- 「清空缓存」按钮直接放在浏览窗口底部操作栏，与「全选/下载选中」等操作按钮混在一起。
- 下载多门课的文件时，全部落到浏览器默认下载目录，无法按课程自动分文件夹。
- 个别课堂（leaf）底下没有可导出的课件，下载时行内统一显示「失败」，用户无法区分「没文件」与「下载出错」。

目标（三个功能）：

1. **设置版块**：新增 ⚙ 设置入口（浏览窗口右上角），把「清空缓存」移入设置内；设置内新增「保存目录」「分类下载」。
2. **分类下载 + 自定义保存目录**：设置中选择自定义保存目录（跨会话记住）；开启分类后，下载多门课文件时自动按课程建文件夹并写入对应文件夹。
3. **无文件提示**：下载时若检测到失败原因是「该课堂无课件文件」，行内提示「此课堂无文件」而非笼统的「失败」。

### 已确认的需求决策

| 决策点 | 结论 |
|--------|------|
| 主力浏览器 | Chrome / Edge（File System Access API）；Firefox 无目录选择，自动回退原生下载 |
| 文件夹命名 | `课程名（班级名）`（多班共享 courseId，班级名区分课堂） |
| 目录记忆 | 跨会话记住：目录句柄存 IndexedDB，下次自动恢复（下载前需重新授权一次） |
| 设置入口 | 浏览窗口**顶部栏右上角 ⚙**；面板改「固定头部 + 滚动列表 + 固定底部」 |
| 下载路由 | 选定目录后**所有**下载走 FileSystem 写入路径；未选目录回退原生下载（方案 A） |
| 无文件提示 | 带 `isNoCourseware` 标记的错误，`exportSlidesPdf` 三处无课件场景抛出 |
| 版本 | 新功能 → @version 1.3.0，package.json 同步 |

## 二、架构与改动范围

### 2.1 设置存储

| 存储 | 键 | 内容 | 说明 |
|------|-----|------|------|
| GM 存储（GM_setValue） | `rcppt_settings` | JSON `{ categorize: boolean }` | 分类开关等简单配置；读取时容错（非法/缺字段 → `{ categorize: false }`） |
| IndexedDB | `rcppt_save_dir` | FileSystemDirectoryHandle | 目录句柄为结构化克隆对象，不能 JSON 序列化，必须用 IDB |

- 脚本加载时从 IDB 读句柄；下载前调 `handle.requestPermission({ mode:'readwrite' })`（下载按钮点击即用户手势）；授权被拒 / 句柄失效 → 该次回退原生下载。
- 设置面板「保存目录」区显示句柄 `name`（API 不暴露完整路径），提供「选择目录」「清除目录」按钮。

### 2.2 UI 改造

**面板结构**：`.rcppt-panel` 改 flex 纵向布局：
- 顶部栏（`.rcppt-browse-top`）`flex: none`——不再随列表滚动，扫描/返回/⚙ 始终可见
- 列表区（新增 `.rcppt-list`）`flex: 1; overflow: auto`
- 底部操作栏 `flex: none`

**⚙ 设置入口**：两级顶部栏右上角各加 ⚙ 按钮（第一级「扫描」左侧、第二级标题右侧），点击 `renderSettings()` 弹出设置面板（遮罩 + 独立 modal，复用 `rcppt-mask/rcppt-panel` 模式）。

**设置面板内容**：

```
⚙ 设置
─────────────
📂 保存目录
   [当前: 我的资料夹]          ← 句柄 name
   [选择目录]  [清除目录]

🗂 分类下载
   ☑ 按课程自动创建文件夹（课程名（班级名））
   （未选目录时置灰 + 提示「需先选择保存目录」）

🧹 清空缓存
   [清空缓存]（confirm 二次确认）

[关闭]
```

- 分类开关勾选/取消即时写 GM 存储；底部操作栏移除「清空缓存」，只剩 全选 / 下载选中 / 关闭。

### 2.3 下载路由（方案 A）

`downloadFiles` 批次开始时决策一次：
- 目录句柄可用 + 授权成功 → **本批走 FileSystem 写入路径**
- 否则 → **整批回退原生下载**

**分类开关行为**：
- 开启分类 + 已选目录 → 每个文件写入 `课程名（班级名）` 子文件夹
- 关闭分类 + 已选目录 → 所有文件直接写入所选目录根（不建子文件夹）

分类写入流程（开启分类时）：

```
dirHandle
 └─ getDirectoryHandle(courseFolderName, { create:true })   ← 按课程建/复用文件夹
     └─ getFileHandle(filename, { create:true })
         └─ createWritable() → write(blob) → close()
```

- 文件夹名 = `sanitizeFilename('课程名（班级名）')`，无班级名则仅课程名
- 文件名：img 类型 `sanitizeFilename(name) + '.pdf'`；直链类型用 `r.name` 或 URL 推导并补扩展名（顺带修复开发日志待办 #7）
- 直链文件取字节：`fetch(r.url, { mode:'cors', credentials:'omit' })`（同封面策略）→ 个别 CDN 拦截 → 该文件回退原生 `a.download`
- 行内状态/进度（`mark` 回调、图片流「拉取图片 n/total」）与失败隔离、800ms 间隔均沿用

### 2.4 无文件提示

`logic.js` 新增错误工厂：

```js
coursewareNoFileError() → { message: '此课堂无文件', isNoCourseware: true }
```

`exportSlidesPdf` 编排链中三处「无课件」场景抛出：
- `leafInfo.courseware_id` 为空
- `review.timelineList` 为空 / `[0]` 不存在
- `slideList` 为空（替换现「课件无分片图片」错误）

`downloadFiles` catch 判断 `err.isNoCourseware` → 行内标「此课堂无文件」（灰色，非红色「失败」）。真正的网络/API/鉴权错误仍按「失败」处理。

## 三、错误处理

| 场景 | 处理 |
|------|------|
| 目录选择被拒 / 无 showDirectoryPicker | 整批回退原生下载（现状行为），设置面板置灰分类项 |
| 授权被拒（requestPermission 失败） | 该次回退原生下载 |
| 直链 fetch 被 CDN 拦截 | 该文件回退原生 `a.download` |
| 写文件失败 | 行标「失败」，其余文件继续 |
| 无课件（三种场景） | 行内「此课堂无文件」（灰色） |
| 清空缓存 | `confirm()` → Store.clear() → 重渲染空状态 |

## 四、测试

- **单测（logic.js）新增纯函数**：
  - `courseFolderName(courseName, className)`：返回净化后的「课程名（班级名）」/ 仅课程名；含非法字符、空班级名分支
  - `coursewareNoFileError()`：返回对象结构正确（message + isNoCourseware 标记）
- **既有 30 个测试保持全绿**；`npm run build` + `npm test` 通过
- **Playwright 手动验证**（仓库惯例，浏览器复用登录态）：
  - ⚙ 打开设置面板；选目录后显示目录名；清除目录生效
  - 分类开关：开启后下载多门课 → 每课生成「课程名（班级名）」文件夹、文件落位正确
  - 未选目录下载 → 回退原生下载
  - 无课件课堂下载 → 行内「此课堂无文件」
  - 面板滚动时顶部栏（⚙/扫描）保持可见

## 五、README 与版本

- README「功能特性」「使用教程」「已知限制」同步更新：设置入口、保存目录、分类下载、无文件提示
- `@version` 1.2.0 → 1.3.0；package.json `version` 同步
- `@updateURL` 不变

## 六、范围外（YAGNI）

- 不做目录内的文件重命名/去重（文件名冲突直接覆盖或复用）
- 不做多目录配置 / 每课单独指定目录
- 不改动网络层 Api / 缓存结构（`rcppt_cache_v1` 与 version: 1 不变，旧缓存兼容）
- 不为 Firefox 实现目录选择（技术上不可行，仅回退）
- 不做目录句柄的可视化树形浏览
