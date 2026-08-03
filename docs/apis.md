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
- ⚠️ **无原始 PPT/PDF 文件**，只有分片图片 → 通过打印功能导出 PDF（见下）

## 7. 打印页（PDF 输出）

- 打印页地址：`/web/print`（无 URL 参数，数据从 localStorage 读取）
- **数据写入**：`localStorage.setItem('rain_print', JSON.stringify({Slides, Width, Height, Title, printType}))`
  - `Slides`：由 slideList 构造，每项含 `{id, index, cover, ...}`（实测 111 项对应 111 页）
  - `Width` / `Height`：PPT 画布尺寸（可省略或取默认）
  - `Title`：课件名
- **输出**：页面渲染全部 PPT 页后：
  - 半自动：`window.print()` → 浏览器打印框 → 用户"另存为 PDF"
  - 全自动（CDP）：`Page.printToPDF` 直接生成 PDF（需 Chrome 带 `--remote-debugging-port` 启动），回退到半自动
- 已用 playwright `page.pdf()` 验证：111 页 A4 横向 PDF（16.5MB）输出成功

## 请求时序（脚本模拟）

```
课程列表 → 对每课: 课程详情(拿 course_sign) → chapter(拿 leaf) → 每 leaf: leaf_level_info(拿 courseware_id)
       → review(拿 presentationId) → ppt(拿 slideList) → 写 rain_print → 打印页 → PDF
```
