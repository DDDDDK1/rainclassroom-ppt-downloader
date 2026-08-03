// ==UserScript==
// @name         长江雨课堂PPT下载器
// @namespace    https://github.com/DDDDDK1/rainclassroom-ppt-downloader
// @version      0.1.0
// @description  便捷下载长江雨课堂中的PPT课件（增量检测）
// @author       DDDDDK1
// @match        https://changjiang.yuketang.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

/* __LOGIC__ */

(function () {
  'use strict';
  const Logic = window.RCLogic;

  // 接口地址集中常量（依据 docs/apis.md 的 Task 1 实际抓包结果修改）
  // ===== 接口地址常量（依据 docs/apis.md）=====
  const API = {
    courses: '/v2/api/web/courses/list',
    classroom: '/v2/api/web/classrooms/',
    chapter: '/mooc-api/v1/lms/learn/course/chapter',
    leafInfo: '/edu_admin/leaf_level_info/',
    review: '/api/v3/classroom-report/student/review',
    ppt: '/api/v3/classroom-report/student/ppt'
  };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function readCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? m[1] : '';
  }

  async function fetchJson(url, extra = {}) {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'x-csrftoken': readCsrf(),
        'xtbz': 'ykt',
        ...(extra.headers || {})
      }
    });
    if (res.status === 401) throw Object.assign(new Error('AUTH_EXPIRED'), { code: 401 });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const Api = {
    // 1. 课程列表（我听的课），一次性返回全部
    async fetchCourses() {
      const data = await fetchJson(API.courses + '?identity=2');
      return (data.data.list || []).map((c) => ({
        classroomId: c.classroom_id,
        courseId: c.course.id,
        courseName: c.course.name,
        className: c.name,
        teacher: c.teacher && c.teacher.name,
        role: c.role
      }));
    },

    // 2. 课程详情 → course_sign / free_sku_id / uv_id
    async fetchClassroom(classroomId) {
      const data = await fetchJson(API.classroom + classroomId + '?role=5');
      return data.data;
    },

    // 3. 课件列表（chapter → leaf[]）
    async fetchChapter(classroomId, sign, uvId) {
      const url = `${API.chapter}?cid=${classroomId}&sign=${sign}&term=latest&uv_id=${uvId}&classroom_id=${classroomId}`;
      const data = await fetchJson(url, { headers: { 'x-client': 'web', 'terminal-type': 'web' } });
      const leaves = [];
      for (const ch of data.data.course_chapter || []) {
        for (const leaf of ch.section_leaf_list || []) {
          leaves.push({ name: leaf.name, leafId: leaf.id, leafType: leaf.leaf_type, leafinfoId: leaf.leafinfo_id });
        }
      }
      return leaves;
    },

    // 4. leaf → courseware_id
    async fetchLeafInfo(classroomId, leafId, uvId) {
      const url = `${API.leafInfo}?leaf_level_id=${leafId}&no_loading=false&term=latest&uv_id=${uvId}&classroom_id=${classroomId}`;
      const data = await fetchJson(url);
      return data; // { activity_id, courseware_id, classroom_id }
    },

    // 5. review → timelineList[]（含 presentationId）
    async fetchReview(coursewareId) {
      const url = `${API.review}?lesson_id=${coursewareId}&front_time=${Date.now()}`;
      const data = await fetchJson(url);
      return data.data;
    },

    // 6. PPT 分片 → slideList[]
    async fetchPpt(coursewareId, presentationId) {
      const url = `${API.ppt}?lesson_id=${coursewareId}&presentationId=${presentationId}&front_time=${Date.now()}`;
      const data = await fetchJson(url);
      return data.data.slideList || [];
    }
  };

  console.log('[雨课堂PPT下载器] 脚本已加载', Logic);
})();
