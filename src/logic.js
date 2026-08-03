'use strict';
const RCLogic = (function () {
  const STORE_VERSION = 1;

  function emptyCache() {
    return { version: STORE_VERSION, courses: [] };
  }

  function parseCache(raw) {
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.courses)) return emptyCache();
      return data;
    } catch (e) {
      return emptyCache();
    }
  }

  function serializeCache(cache) {
    return JSON.stringify(cache);
  }

  function upsertCourse(cache, course) {
    const courses = cache.courses.filter((c) => c.courseId !== course.courseId);
    courses.push(course);
    return { version: cache.version, courses };
  }

  function classifyResource(item) {
    const type = String(item.type || item.file_type || '').toLowerCase();
    const name = String(item.name || '').toLowerCase();
    if (type === 'pdf' || name.endsWith('.pdf')) return 'pdf';
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
        (c) => c.courseId === fetched.courseId
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
          resource: { ...resource, type, scanTime: Date.now() }
        });
      }
    }

    addedResourceCount = addedResources.length;
    return { addedResources, addedCourseCount, addedResourceCount };
  }

  return {
    emptyCache,
    parseCache,
    serializeCache,
    upsertCourse,
    classifyResource,
    diffCourses,
    // 后续任务填充：buildCache
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RCLogic;
}
if (typeof window !== 'undefined') window.RCLogic = RCLogic;
