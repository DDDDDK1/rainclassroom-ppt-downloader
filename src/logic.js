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

  return {
    emptyCache,
    parseCache,
    serializeCache,
    upsertCourse,
    classifyResource,
    diffCourses,
    collectSelection,
    // 后续任务填充：buildCache
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RCLogic;
}
if (typeof window !== 'undefined') window.RCLogic = RCLogic;
