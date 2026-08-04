# 二级浏览窗口 — 设计文档

> 日期：2026-08-04
> 状态：已确认
> 分支：`feature/browse-window`（基于 master @ 7d6c759）
> 目标产物：油猴脚本 `rainclassroom-ppt-downloader.user.js`（@version 1.0.0 → 1.1.0）

## 一、背景与目标

现状：悬浮主按钮点击即触发扫描，结果面板只显示**新增**课件；缓存 `rcppt_cache_v1`（GM 存储）已保存全部课程与资源，但无任何 UI 能浏览**已扫描的全部内容**；复选框为原生样式、无选中反馈；「清空缓存」藏在扫描结果面板里（仅在扫描有新增/失败时才可见）。

目标：把主按钮改为打开**二级浏览窗口**（统一中心），可浏览已扫描的全部课程/文件、勾选（带行高亮选中效果）并下载、随时清空缓存；扫描移入窗口内。

### 已确认的需求决策

| 决策点 | 结论 |
|--------|------|
| 主按钮行为 | 点击 → 打开浏览窗口（不再直接扫描） |
| 窗口结构 | 下钻式两级：课程列表 → 点击课程 → 该课文件列表 |
| 扫描流程 | 统一中心：窗口内「扫描」按钮，完成后刷新列表 + 「新」徽标 + 横幅；**取消**旧的独立扫描结果面板 |
| 选中效果 | 勾选复选框 → 整行浅蓝背景 + 左侧 3px 蓝色色条 |
| 下载 | 浏览窗口内支持下载选中文件（复用现有下载/打印链路）；第一级勾选课程 = 批量下载该课全部文件 |
| 清空缓存 | 第一级与第二级操作栏均保留，`confirm()` 二次确认 |
| 版本 | 新功能 → @version 1.1.0，package.json 同步 |

## 二、架构与改动范围

### 2.1 UI 流程重构

```
旧：主按钮 onScanClick → runScan → showPanel（仅新增）
新：主按钮 openBrowse → 浏览窗口
    ├─ 第一级：课程列表（缓存全部课程，可勾选）→ 点击行下钻
    ├─ 第二级：某课文件列表（可勾选 + 「新」徽标）→ 返回
    ├─ 窗口顶部：「扫描」按钮 → runScan → 刷新 + 横幅（发现 N 个新课件）
    └─ 底部操作栏（两级均有）：全选 / 下载选中 / 清空缓存 / 关闭
```

退役代码：`showPanel(diff)` 整段、`onScanClick` 中"有新增→showPanel"路径改为打开浏览窗口。`onDownloadClick(panel)` 重构为 `downloadRows(rows)`（接受行列表，供两级复用）。

### 2.2 组件职责

| 组件 | 职责 | 关键点 |
|------|------|--------|
| `openBrowse()` | 主按钮点击入口；渲染浏览窗口第一级（或空状态） | 空缓存 → 「暂无已扫描课件」+「开始扫描」 |
| `renderCourses(cache, newKeys)` | 第一级课程列表渲染 | 行：复选框 + 课程名 + N 课件 + 教室名后缀；新课件课程行可显「+N 新」 |
| `renderFiles(course, newKeys)` | 第二级文件列表渲染 | 行：复选框 + 类型徽标 + 文件名 + 状态；新课件加「新」徽标 |
| `toggleSelect(row, cb)` | 选中效果：勾选 → 行加 `.selected`（背景 + 色条） | 复选框 change 监听 |
| `collectSelection`（logic.js 新增） | 纯函数：把第一级课程选择展开为具体文件、与第二级选择合并去重 | 可单测 |
| `downloadRows(rows)` | 逐行下载（复用 Print.exportPdf / triggerDownload + markRow） | 由 `onDownloadClick` 重构而来 |
| 窗口内扫描 | 复用 `runScan()` → 返回 diff → 刷新列表 + 「新」徽标 + 横幅 | 401/失败/连续失败逻辑沿用 |

### 2.3 缓存与数据流

- 浏览窗口读 `Store.load()`（`Logic.parseCache`），渲染内存中的 cache 对象，不写回。
- 扫描复用 `runScan()`：计算 diff → 同步合并写入缓存 → 返回 diff。窗口据 `diff.addedResources` 生成会话级 `newKeys`（`courseId:classroomId:resourceId` 集合），供两级「新」徽标使用（会话内有效，窗口关闭即失效）。
- `collectSelection(cache, courseRefs, resourceRefs)`：
  - `courseRefs: [{courseId, classroomId}]` → 展开为该课全部资源
  - `resourceRefs: [{courseId, classroomId, resourceId}]` → 具体文件
  - 返回 `[{courseId, classroomId, courseName, className, resource}]`，按 `courseId:classroomId:resourceId` 去重合并
  - 用于第一级「下载选中」（只传 courseRefs）与第二级「下载选中」（只传 resourceRefs）共用一个下载入口

### 2.4 样式（选中效果）

```css
.rcppt-row.selected{background:#e8f3ff;box-shadow:inset 3px 0 0 #0088ff}
.rcppt-badge.new{background:#f5a623}
.rcppt-browse-top{...} /* 窗口顶部：标题 + 扫描按钮 */
```

复用现有 `.rcppt-btn/.rcppt-mask/.rcppt-panel/.rcppt-row/.rcppt-badge` 等。

## 三、错误处理

| 场景 | 处理 |
|------|------|
| 扫描 401 | `alert('登录已失效，请重新登录后重试')`（沿用） |
| 扫描其他错误 | `alert('扫描失败：' + err.message)` + 连续失败 ≥2 次追加「接口可能已变更」（沿用） |
| 单课失败 | 窗口内横幅追加「N 门课扫描失败已跳过，详情见控制台」（沿用 console.warn） |
| 清空缓存 | `confirm('确定清空缓存？该操作不可撤销。')` → Store.clear() → 重渲染空状态 |
| 下载失败 | 行状态标「失败」（沿用 markRow） |

## 四、测试

- **单测（logic.js）**：`collectSelection`
  - 只传 courseRefs → 展开课程全部资源
  - 只传 resourceRefs → 具体文件
  - 两级混合 → 去重合并（同一文件不重复）
  - 未知引用 → 忽略（不报错）
  - 空输入 → 空数组
- **Playwright 手动验证**（仓库惯例，浏览器复用登录态）：
  - 主按钮点击打开浏览窗口；空缓存显示空状态
  - 第一级列全部课程；勾选课程行高亮 + 色条
  - 点击课程下钻第二级；勾选文件行高亮；返回导航
  - 窗口内扫描：刷新列表、新课件「新」徽标、横幅计数
  - 第二级「下载选中」走打印导出 PDF（CDP 或半自动）
  - 第一级「下载选中」批量下载
  - 「清空缓存」confirm → 回到空状态
- 构建：`npm run build` 后 `git add -f` 产物入库（产物在 .gitignore 但强制跟踪）

## 五、README 与版本

- README「功能特性」：主按钮打开浏览窗口、两级浏览、选中效果、窗口内扫描；「使用步骤」与「已知限制」同步更新；移除「无新增时提示」描述或改为窗口内横幅
- `@version` 1.0.0 → 1.1.0；package.json `version` 同步 1.1.0
- `@updateURL` 不变（master 分支，默认分支未改）

## 六、范围外（YAGNI）

- 不引入课程级折叠动画/虚拟滚动（列表量小）
- 不做搜索/筛选
- 不做「新」徽标持久化（仅会话内）
- 不改动网络层 Api / 打印模块 / 缓存结构（version: 1 不变，旧缓存兼容）
