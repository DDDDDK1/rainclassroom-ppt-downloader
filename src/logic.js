'use strict';
const RCLogic = (function () {
  const STORE_VERSION = 1;

  function emptyCache() {
    return { version: STORE_VERSION, courses: [] };
  }

  function parseCache(raw) {
    try {
      const data = JSON.parse(raw);
      // 版本不符（Task 3 Minor）或结构不符 → 空缓存自愈
      if (!data || data.version !== STORE_VERSION || !Array.isArray(data.courses)) return emptyCache();
      // 归一化（Task 6 Minor）：丢弃无 courseId 脏条目；无 classroomId 的旧格式孤儿条目
      // 尽力从资源级 classroomId 补齐，否则丢弃（下次扫描重新收录）
      const courses = [];
      for (const c of data.courses) {
        if (!c || !c.courseId) continue;
        let classroomId = c.classroomId;
        if (!classroomId && Array.isArray(c.resources)) {
          const withK = c.resources.find((r) => r && r.classroomId);
          if (withK) classroomId = withK.classroomId;
        }
        if (!classroomId) continue;
        courses.push({ ...c, classroomId, resources: Array.isArray(c.resources) ? c.resources : [] });
      }
      return { version: STORE_VERSION, courses };
    } catch (e) {
      return emptyCache();
    }
  }

  function serializeCache(cache) {
    return JSON.stringify(cache);
  }

  function upsertCourse(cache, course) {
    const courses = cache.courses.filter(
      (c) => !(c.courseId === course.courseId && c.classroomId === course.classroomId)
    );
    courses.push(course);
    return { version: cache.version, courses };
  }

  function classifyResource(item) {
    const type = String(item.type || item.file_type || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    if (type === 'pdf' || (!type && name.endsWith('.pdf'))) return 'pdf';
    if (type === 'pptx' || type === 'ppt' && item.url) return 'pptx';
    // ppt 分片预览（无原始文件）→ 图片流
    if (type === 'ppt' || type === 'image' || type === 'img') return 'img';
    if (type === 'video' || type === 'audio') return 'other';
    return 'other';
  }

  function diffCourses(existingCache, fetchedCourses) {
    const addedResources = [];
    let addedCourseCount = 0;
    let addedResourceCount = 0;

    for (const fetched of fetchedCourses) {
      const existingCourse = existingCache.courses.find(
        (c) => c.courseId === fetched.courseId && c.classroomId === fetched.classroomId
      );
      const knownIds = new Set((existingCourse ? existingCourse.resources : []).map((r) => r.resourceId));

      if (!existingCourse) addedCourseCount += 1;

      for (const resource of fetched.resources || []) {
        const type = classifyResource(resource);
        if (type === 'other') continue;          // 过滤视频/音频/无关项
        if (knownIds.has(resource.resourceId)) continue; // 已存在 → 跳过
        addedResources.push({
          courseId: fetched.courseId,
          courseName: fetched.courseName,
          classroomId: fetched.classroomId,
          className: fetched.className,
          resource: { ...resource, type, scanTime: Date.now() }
        });
      }
    }

    addedResourceCount = addedResources.length;
    return { addedResources, addedCourseCount, addedResourceCount };
  }

  // 浏览窗口：把课程级选择展开为具体文件、与文件级选择合并去重
  function collectSelection(cache, courseRefs, resourceRefs) {
    const result = [];
    const seen = new Set();
    const push = (course, resource) => {
      const key = `${course.courseId}:${course.classroomId}:${resource.resourceId}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({
        courseId: course.courseId,
        classroomId: course.classroomId,
        courseName: course.courseName,
        className: course.className,
        resource
      });
    };
    (courseRefs || []).forEach((ref) => {
      const course = cache.courses.find(
        (c) => c.courseId === ref.courseId && c.classroomId === ref.classroomId
      );
      if (!course) return;
      (course.resources || []).forEach((r) => push(course, r));
    });
    (resourceRefs || []).forEach((ref) => {
      const course = cache.courses.find(
        (c) => c.courseId === ref.courseId && c.classroomId === ref.classroomId
      );
      if (!course) return;
      const resource = (course.resources || []).find((r) => r.resourceId === ref.resourceId);
      if (resource) push(course, resource);
    });
    return result;
  }

  // 文件名净化：过滤 Windows/跨平台非法字符（Task：前端合成 PDF）
  function sanitizeFilename(name) {
    const s = String(name || '').replace(/[\/\\:*?"<>|]/g, '_').trim();
    return s || 'courseware';
  }

  // 解析 JPEG SOF 帧头取宽高（封面为 JPEG 时直嵌 PDF，免解码）
  function jpegDimensions(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('非 JPEG 文件');
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xFF || marker === 0x00) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; } // 无长度段
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) { i += 2; continue; }
      const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof) {
        if (i + 9 > b.length) throw new Error('JPEG SOF 段截断');
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + len;
    }
    throw new Error('未找到 JPEG SOF 段');
  }

  return {
    emptyCache,
    parseCache,
    serializeCache,
    upsertCourse,
    classifyResource,
    diffCourses,
    collectSelection,
    sanitizeFilename,
    jpegDimensions,
    // 后续任务填充：buildCache
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RCLogic;
}
if (typeof window !== 'undefined') window.RCLogic = RCLogic;
