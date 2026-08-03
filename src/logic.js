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

  return {
    emptyCache,
    parseCache,
    serializeCache,
    upsertCourse,
    // 后续任务填充：buildCache / diffCourses / classifyResource
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RCLogic;
}
if (typeof window !== 'undefined') window.RCLogic = RCLogic;
