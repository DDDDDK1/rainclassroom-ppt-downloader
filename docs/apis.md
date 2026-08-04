# 长江雨课堂接口契约（2026-08-03 抓包确认）

> 站点：`changjiang.yuketang.cn`，登录态由 Cookie 携带（csrftoken / uv_id / university_id / platform_id / xtbz）。
> **签名结论：无动态加密签名。** `sign` = 课程详情接口返回的 `course_sign`，每课一个固定 token，脚本直接获取即可。

## 通用请求要素

- 基础 URL：`https://changjiang.yuketang.cn`
- Cookie（浏览器同源 fetch 自动携带）：`csrftoken`, `uv_id`, `university_id`, `platform_id`, `xtbz`, `classroom_id`
- 关键自定义请求头（fetch 时需手动补，值见各接口抓包）：
  - `x-csrftoken` = Cookie 中的 `csrftoken`（必需）
  - `xtbz: ykt`（必需）
  - `university-id: 3612`（= uv_id）
  - `platform-id: 3`
  - `x-client: web`、`terminal-type: web`（mooc-api 接口）
- 常用 URL 参数：`term=latest`、`uv_id={uv_id}`、`classroom_id={classroom_id}`

## 1. 课程列表

- **URL**: `GET /v2/api/web/courses/list?identity=2`
- **identity**: `2` = 我听的课；`1` = 我教的课
- **入参**: 无分页（一次性返回全部课程，实测 48 门）
- **响应**: `{errcode:0, data:{ list: [课程对象] }}`
- **关键字段**（课程对象）:
  - `classroom_id` → 课堂 ID（用于后续所有接口）
  - `course.id` → 课程 ID（course_id）
  - `course.name` → 课程名
  - `name` → 班级名、`teacher.name` → 教师名、`role` → 5学生/6旁听

## 2. 课程详情（含 sign）

- **URL**: `GET /v2/api/web/classrooms/{classroom_id}?role=5`
- **响应**: `{errcode:0, data:{...}}`
- **关键字段**:
  - `course_sign` → **sign token**（用于所有 mooc-api 接口）
  - `free_sku_id` → 用于 `reset_leaf` / `sku_list`
  - `course_id`, `course_name`, `teacher_name`

## 3. 课件列表（chapter）

- **URL**: `GET /mooc-api/v1/lms/learn/course/chapter?cid={classroom_id}&sign={course_sign}&term=latest&uv_id={uv_id}&classroom_id={classroom_id}`
- **响应**: `{data:{course_id, course_name, course_chapter:[...]}}`
- **course_chapter[]** → 章节，每章含 `section_leaf_list[]`（教学活动 leaf）
- **leaf 关键字段**:
  - `name` → 课件/活动名
  - `id` → leaf 唯一 ID（用于 leaf_level_info）
  - `leaf_type` → 8 = 线上学习/课件；其他类型需过滤
  - `leafinfo_id` → leaf 信息 ID
  - `is_show`, `is_locked`

## 4. leaf → courseware_id

- **URL**: `GET /edu_admin/leaf_level_info/?leaf_level_id={leaf_id}&no_loading=false&term=latest&uv_id={uv_id}&classroom_id={classroom_id}`
- **响应**: `{activity_id, lesson_tatus, courseware_id, classroom_id}`
- `courseware_id` = 课件 ID（即后续的 `lesson_id`）

## 5. 课件详情 → presentationId

- **URL**: `GET /api/v3/classroom-report/student/review?lesson_id={courseware_id}&front_time={ts}`
- **响应**: `{code:0, data:{timelineList:[...]}}`
- **timelineList[]** 中每项含 `presentationId`（本课固定一个），以及 `cover`（图片）、`index`、`type`
- `front_time` = 毫秒时间戳（防缓存，用 `Date.now()` 即可）

## 6. PPT 分片图片（图片流）

- **URL**: `GET /api/v3/classroom-report/student/ppt?lesson_id={courseware_id}&presentationId={presentationId}&front_time={ts}`
- **响应**: `{code:0, data:{slideList:[...]}}`
- **slideList[]** 每项:
  - `id` → 页面 ID
  - `index` → 页码
  - `cover` → **该页 PPT 图片 URL**（`https://changjiang-private-qn.yuketang.cn/slide/...`，带 `e=` 过期时间 + `token=` 鉴权）
- ⚠️ **无原始 PPT/PDF 文件**，只有分片图片 → 前端合成 PDF 导出（见下）

## 7. 图片型课件 → 前端合成 PDF（下载）

图片型课件（`type:'img'`）无原始 PPT/PDF 文件，只有分片图片（见 §6）。脚本在前端逐页拉取完整封面字节，合成为单个 PDF 后自动下载（无弹窗、无外部 Chrome）：

- **API 链**（懒加载，随下载按需请求）：
  - `fetchLeafInfo(classroomId, leafId, uv_id)`（§4）→ 取 `courseware_id`
  - `fetchReview(courseware_id)`（§5）→ 取 `timelineList[0].presentationId`
  - `fetchPpt(courseware_id, presentationId)`（§6）→ 取 `slideList[]`
- **封面拉取**：对 slideList 每项的 `cover` 用 `fetch(cover, {mode:'cors', credentials:'omit'})`——跨域私有 CDN 允许无凭据读取字节（token 在 URL 内，无需 Cookie）。20s 超时 + 失败重试一次（间隔 1s）；并发上限 5；逐页失败隔离（失败页跳过，PDF 页数 = 成功页数，全部失败才抛错）。
- **合成**：`Logic.buildSlidesPdf(pages)`——JPEG 字节直嵌（`/Filter /DCTDecode`，免解码），页尺寸统一为第一个成功页，其余页等比缩放居中（铺白底，不拉伸变形）。
- **下载**：合成 PDF → Blob → 浏览器原生下载 `sanitizeFilename(name) + '.pdf'`（文件名过滤 `\ / : * ? " < > |` 非法字符）。

## 请求时序（脚本模拟）

```
课程列表 → 对每课: 课程详情(拿 course_sign) → chapter(拿 leaf) → 每 leaf: leaf_level_info(拿 courseware_id)
       → review(拿 presentationId) → ppt(拿 slideList) → fetch 封面字节 → buildSlidesPdf 合成 → Blob 下载
```
