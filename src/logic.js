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

  // 分类下载：课程文件夹名（净化后；有班级名时用全角括号拼接）
  function courseFolderName(courseName, className) {
    const base = className ? `${courseName}（${className}）` : courseName;
    return sanitizeFilename(base);
  }

  // 无文件错误工厂：供下载链路识别「此课堂无文件」
  function coursewareNoFileError() {
    const err = new Error('此课堂无文件');
    err.isNoCourseware = true;
    return err;
  }

  // 手写极简 PDF 写入器：每页一张全幅 JPEG，页尺寸统一为 pages[0]
  function buildSlidesPdf(pages) {
    if (!Array.isArray(pages) || !pages.length) throw new Error('无可合成页面');
    const first = pages[0];
    if (!first || !first.width || !first.height) throw new Error('页面尺寸无效');
    const pageW = first.width;
    const pageH = first.height;

    const enc = new TextEncoder();
    const chunks = [];
    let offset = 0;
    const xref = [];
    const pushStr = (s) => { const u = enc.encode(s); chunks.push(u); offset += u.length; };
    const pushBytes = (u) => { chunks.push(u); offset += u.length; };
    const markObj = () => xref.push(offset);
    const fmt = (n) => Math.round(n * 1000) / 1000;

    pushStr('%PDF-1.4\n');
    const n = pages.length;

    markObj(); // 1 Catalog
    pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    const kids = pages.map((_, p) => `${3 + p * 3} 0 R`).join(' ');
    markObj(); // 2 Pages
    pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

    pages.forEach((pg, p) => {
      const pageObj = 3 + p * 3, contentObj = pageObj + 1, imgObj = pageObj + 2;
      const iw = pg.width, ih = pg.height;
      const content = (iw === pageW && ih === pageH)
        ? `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q\n`
        : (() => {
            const s = fmt(Math.min(pageW / iw, pageH / ih));
            const dx = fmt((pageW - iw * s) / 2);
            const dy = fmt((pageH - ih * s) / 2);
            return `q ${s} 0 0 ${s} ${dx} ${dy} cm /Im0 Do Q\n`;
          })();
      const contentBytes = enc.encode(content);

      markObj(); // Page
      pushStr(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);

      markObj(); // Contents
      pushStr(`${contentObj} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      pushBytes(contentBytes);
      pushStr('\nendstream\nendobj\n');

      markObj(); // Image
      pushStr(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
      pushBytes(pg.bytes);
      pushStr('\nendstream\nendobj\n');
    });

    const xrefOffset = offset;
    let xrefStr = `xref\n0 ${xref.length + 1}\n0000000000 65535 f \n`;
    xref.forEach((off) => { xrefStr += `${String(off).padStart(10, '0')} 00000 n \n`; });
    pushStr(xrefStr);
    pushStr(`trailer\n<< /Size ${xref.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const total = chunks.reduce((s, u) => s + u.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const u of chunks) { out.set(u, o); o += u.length; }
    return out;
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
    buildSlidesPdf,
    courseFolderName,
    coursewareNoFileError,
    // 后续任务填充：buildCache
  };
})();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RCLogic;
}
if (typeof window !== 'undefined') window.RCLogic = RCLogic;
