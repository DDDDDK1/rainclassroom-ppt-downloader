// ==UserScript==
// @name         长江雨课堂PPT下载器
// @namespace    https://github.com/DDDDDK1/rainclassroom-ppt-downloader
// @version      1.1.0
// @description  便捷下载长江雨课堂中的PPT课件（增量检测）
// @author       DDDDDK1
// @homepageURL  https://github.com/DDDDDK1/rainclassroom-ppt-downloader
// @updateURL    https://raw.githubusercontent.com/DDDDDK1/rainclassroom-ppt-downloader/master/rainclassroom-ppt-downloader.user.js
// @license      MIT
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000); // 20s 请求超时兜底：防 fetch 悬挂永久卡死扫描
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'x-csrftoken': readCsrf(),
          'xtbz': 'ykt',
          ...(extra.headers || {})
        },
        signal: controller.signal
      });
      if (res.status === 401) throw Object.assign(new Error('AUTH_EXPIRED'), { code: 401 });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      // 业务错误码检查（Task 5 Minor）：HTTP ok 但业务码非成功 → 抛明确信息
      if (data && typeof data.errcode === 'number' && data.errcode !== 0) {
        throw new Error('业务错误 errcode=' + data.errcode + (data.msg ? '：' + data.msg : ''));
      }
      if (data && typeof data.code === 'number' && data.code !== 0) {
        throw new Error('业务错误 code=' + data.code + (data.msg ? '：' + data.msg : ''));
      }
      return data;
    } catch (err) {
      // AbortError（超时中止）→ 转为明确错误信息，交由 fetchWithRetry 重试
      if (err && err.name === 'AbortError') throw new Error('请求超时：' + url);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 重试封装（Task 9 Step 1）：401 不重试；其余错误 sleep(2000) 后重试，最多 retries 次
  async function fetchWithRetry(url, payload, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        return await fetchJson(url, payload);
      } catch (err) {
        if (err.code === 401) throw err; // 登录失效不重试
        lastErr = err;
        if (i < retries - 1) await sleep(2000); // 延时2s重试
      }
    }
    throw lastErr;
  }

  const Api = {
    // 1. 课程列表（我听的课），一次性返回全部
    async fetchCourses() {
      const data = await fetchWithRetry(API.courses + '?identity=2');
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
      const data = await fetchWithRetry(API.classroom + classroomId + '?role=5');
      return data.data;
    },

    // 3. 课件列表（chapter → leaf[]）
    async fetchChapter(classroomId, sign, uvId) {
      const url = `${API.chapter}?cid=${classroomId}&sign=${sign}&term=latest&uv_id=${uvId}&classroom_id=${classroomId}`;
      const data = await fetchWithRetry(url, { headers: { 'x-client': 'web', 'terminal-type': 'web' } });
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
      const data = await fetchWithRetry(url);
      return data; // { activity_id, courseware_id, classroom_id }
    },

    // 5. review → timelineList[]（含 presentationId）
    async fetchReview(coursewareId) {
      const url = `${API.review}?lesson_id=${coursewareId}&front_time=${Date.now()}`;
      const data = await fetchWithRetry(url);
      return data.data;
    },

    // 6. PPT 分片 → slideList[]
    async fetchPpt(coursewareId, presentationId) {
      const url = `${API.ppt}?lesson_id=${coursewareId}&presentationId=${presentationId}&front_time=${Date.now()}`;
      const data = await fetchWithRetry(url);
      return data.data.slideList || [];
    }
  };

  const STORE_KEY = 'rcppt_cache_v1';

  const Store = {
    load() { return Logic.parseCache(GM_getValue(STORE_KEY, '')); },
    save(cache) { GM_setValue(STORE_KEY, Logic.serializeCache(cache)); },
    clear() { GM_setValue(STORE_KEY, ''); }
  };

  async function runScan() {
    const cache = Store.load();
    const courses = await Api.fetchCourses();
    const fetched = [];
    const failed = [];

    for (const course of courses) {
      // 每课：课程详情(拿 course_sign/uv_id) → chapter(拿 leaf)
      // 逐课错误隔离（Task 6 Minor）：单课失败记录并跳过，其余课继续
      try {
        const classroom = await Api.fetchClassroom(course.classroomId);
        const leaves = await Api.fetchChapter(course.classroomId, classroom.course_sign, classroom.uv_id);
        const resources = leaves
          .filter((l) => l.leafType === 8) // 线上学习/课堂 PPT
          .map((l) => ({
            resourceId: String(l.leafId),
            name: l.name,
            type: 'img',        // 课堂 PPT 为图片流 → 打印导出 PDF
            url: null,
            classroomId: course.classroomId,
            leafInfo: l
          }));
        fetched.push({ ...course, resources });
        await sleep(800); // 逐课串行 + 请求间隔
      } catch (err) {
        if (err.code === 401) throw err; // 401 是全局会话信号，中止整轮 → scanAndRefresh AUTH_EXPIRED 提示
        failed.push({ courseName: course.courseName, classroomId: course.classroomId, error: err.message });
        console.warn('[雨课堂PPT下载器] 课程扫描失败，已跳过：' + course.courseName + ' (' + course.classroomId + ') — ' + err.message);
      }
    }

    const diff = Logic.diffCourses(cache, fetched);

    // 同步更新缓存（幂等：全部成功后写入）
    let next = cache;
    for (const course of fetched) {
      const normalized = {
        courseId: course.courseId,
        classroomId: course.classroomId,
        className: course.className,
        courseName: course.courseName,
        resources: course.resources
          .filter((r) => Logic.classifyResource(r) !== 'other')
          .map((r) => ({ ...r, type: Logic.classifyResource(r), scanTime: Date.now() })),
        scanTime: Date.now()
      };
      next = Logic.upsertCourse(next, normalized);
    }
    Store.save(next);

    return Object.assign(diff, { failed });
  }

  console.log('[雨课堂PPT下载器] 脚本已加载', Logic);

  // ===== UI 层（Task 7）：悬浮按钮 + 模态面板 + SPA 保活 =====

  function ensureStyles() {
    const id = 'rcppt-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      .rcppt-btn{position:fixed;right:24px;bottom:80px;z-index:2147483647;
        padding:10px 16px;border:0;border-radius:8px;background:#0088ff;color:#fff;
        cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
      .rcppt-btn[disabled]{opacity:.6;cursor:not-allowed}
      .rcppt-mask{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45)}
      .rcppt-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
        z-index:2147483647;width:640px;max-width:92vw;max-height:80vh;overflow:auto;
        background:#fff;border-radius:10px;padding:16px;font-size:14px;color:#222}
      .rcppt-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #eee}
      .rcppt-badge{padding:1px 6px;border-radius:4px;font-size:12px;color:#fff}
      .rcppt-badge.pdf{background:#2e8b57}.rcppt-badge.pptx{background:#1e6fba}
      .rcppt-badge.img{background:#999}
      .rcppt-row.selected{background:#e8f3ff;box-shadow:inset 3px 0 0 #0088ff}
      .rcppt-badge.new{background:#f5a623}
      .rcppt-browse-top{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:600}
      .rcppt-browse-top .rcppt-scan{margin-left:auto;font-weight:400}
      .rcppt-empty{text-align:center;padding:28px 0;color:#888}
      .rcppt-notice{padding:8px 10px;background:#fff8e1;border:1px solid #ffd54f;border-radius:6px;margin-bottom:8px;color:#6d4c00}
      .rcppt-count{color:#999;font-size:12px}
      .rcppt-status-line{padding:4px 0;font-size:13px}
      .rcppt-course{cursor:pointer}
      .rcppt-row input[type=checkbox]{-webkit-appearance:auto;appearance:auto;width:16px;height:16px;margin:0;flex:none;opacity:1;position:static}
    `;
    document.head.appendChild(style);
  }

  // ===== 浏览窗口（统一中心）状态 =====
  let browseCache = null;               // 浏览窗口的缓存快照（内存中，不写回）
  let browseNewKeys = new Set();        // 会话级「新」徽标：'courseId:classroomId:resourceId'

  function keyOf(course, resource) {
    return course.courseId + ':' + course.classroomId + ':' + resource.resourceId;
  }

  async function openBrowse() {
    closePanel();
    browseCache = Store.load();
    browseNewKeys = new Set();
    renderCourses();
  }

  // 第一级：课程列表（或空状态）
  function renderCourses(notice) {
    closePanel();
    const mask = document.createElement('div');
    mask.className = 'rcppt-mask';
    const panel = document.createElement('div');
    panel.className = 'rcppt-panel';

    const top = document.createElement('div');
    top.className = 'rcppt-browse-top';
    const title = document.createElement('span');
    title.textContent = '📚 已扫描课件';
    const btnScan = document.createElement('button');
    btnScan.className = 'rcppt-scan';
    btnScan.textContent = '扫描';
    btnScan.addEventListener('click', () => scanAndRefresh(panel, btnScan));
    top.append(title, btnScan);
    panel.appendChild(top);

    if (notice) {
      const banner = document.createElement('div');
      banner.className = 'rcppt-notice';
      banner.textContent = notice;
      panel.appendChild(banner);
    }

    if (!browseCache.courses.length) {
      const empty = document.createElement('div');
      empty.className = 'rcppt-empty';
      empty.textContent = '暂无已扫描课件';
      const btnStart = document.createElement('button');
      btnStart.className = 'rcppt-scan';
      btnStart.textContent = '开始扫描';
      btnStart.addEventListener('click', () => scanAndRefresh(panel, btnStart));
      panel.append(empty, btnStart);
    } else {
      const list = document.createElement('div');
      browseCache.courses.forEach((course, i) => {
        const row = document.createElement('div');
        row.className = 'rcppt-row rcppt-course';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.index = String(i);
        const name = document.createElement('span');
        name.textContent = course.className ? `${course.courseName} (${course.className})` : course.courseName;
        const count = document.createElement('span');
        count.className = 'rcppt-count';
        count.textContent = course.resources.length + ' 课件';
        row.append(cb, name, count);
        const newCount = course.resources.filter((r) => browseNewKeys.has(keyOf(course, r))).length;
        if (newCount) {
          const nb = document.createElement('span');
          nb.className = 'rcppt-badge new';
          nb.textContent = '+' + newCount + ' 新';
          row.append(nb);
        }
        cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
        row.addEventListener('click', (e) => { if (e.target !== cb) renderFiles(course); });
        list.appendChild(row);
      });
      panel.appendChild(list);
    }

    const bar = document.createElement('div');
    const btnSelectAll = document.createElement('button');
    btnSelectAll.textContent = '全选';
    btnSelectAll.addEventListener('click', () => {
      panel.querySelectorAll('.rcppt-row input[type=checkbox]').forEach((cb) => {
        if (!cb.disabled) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      });
    });
    const btnDownload = document.createElement('button');
    btnDownload.textContent = '下载选中';
    btnDownload.addEventListener('click', () => onDownloadSelectedCourses(panel));
    const btnClear = document.createElement('button');
    btnClear.textContent = '清空缓存';
    btnClear.addEventListener('click', onClearCache);
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClear, btnClose);
    panel.appendChild(bar);

    const noticeFooter = document.createElement('div');
    noticeFooter.textContent = '课件版权归授课教师所有，仅供个人学习使用，请勿传播';
    panel.appendChild(noticeFooter);

    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.append(mask, panel);
  }

  // 第二级：某课的文件列表
  function renderFiles(course) {
    closePanel();
    const mask = document.createElement('div');
    mask.className = 'rcppt-mask';
    const panel = document.createElement('div');
    panel.className = 'rcppt-panel';

    const top = document.createElement('div');
    top.className = 'rcppt-browse-top';
    const btnBack = document.createElement('button');
    btnBack.textContent = '← 返回';
    btnBack.addEventListener('click', () => renderCourses());
    const title = document.createElement('span');
    title.textContent = course.className ? `${course.courseName} (${course.className})` : course.courseName;
    top.append(btnBack, title);
    panel.appendChild(top);

    const list = document.createElement('div');
    course.resources.forEach((resource, i) => {
      const row = document.createElement('div');
      row.className = 'rcppt-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.index = String(i);
      const badge = document.createElement('span');
      badge.className = 'rcppt-badge ' + resource.type;
      badge.textContent = resource.type === 'pdf' ? 'PDF' : resource.type === 'pptx' ? 'PPTX' : 'PPT(打印)';
      const name = document.createElement('span');
      name.textContent = resource.name;
      row.append(cb, badge, name);
      if (browseNewKeys.has(keyOf(course, resource))) {
        const nb = document.createElement('span');
        nb.className = 'rcppt-badge new';
        nb.textContent = '新';
        row.append(nb);
      }
      // 下载链路 dataset（与旧面板一致）
      row.dataset.url = resource.url || '';
      row.dataset.name = resource.name;
      row.dataset.type = resource.type;
      row.dataset.classroomId = course.classroomId;
      row.dataset.leafId = resource.resourceId;
      cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
      list.appendChild(row);
    });
    panel.appendChild(list);

    const bar = document.createElement('div');
    const btnSelectAll = document.createElement('button');
    btnSelectAll.textContent = '全选';
    btnSelectAll.addEventListener('click', () => {
      panel.querySelectorAll('.rcppt-row input[type=checkbox]').forEach((cb) => {
        if (!cb.disabled) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      });
    });
    const btnDownload = document.createElement('button');
    btnDownload.textContent = '下载选中';
    btnDownload.addEventListener('click', () => onDownloadSelectedFiles(panel));
    const btnClear = document.createElement('button');
    btnClear.textContent = '清空缓存';
    btnClear.addEventListener('click', onClearCache);
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClear, btnClose);
    panel.appendChild(bar);

    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.append(mask, panel);
  }

  // 第一级：勾选课程 → 批量下载该课全部文件
  async function onDownloadSelectedCourses(panel) {
    const courseRefs = Array.from(panel.querySelectorAll('.rcppt-row input[type=checkbox]:checked')).map((cb) => {
      const c = browseCache.courses[Number(cb.dataset.index)];
      return { courseId: c.courseId, classroomId: c.classroomId };
    });
    if (!courseRefs.length) { alert('未勾选任何课程'); return; }
    const files = Logic.collectSelection(browseCache, courseRefs, null);
    if (!files.length) { alert('所选课程暂无文件'); return; }
    const status = document.createElement('div');
    status.className = 'rcppt-status-line';
    panel.appendChild(status);
    const { ok, fail } = await downloadFiles(files, (i, text, color) => {
      status.textContent = `${text} ${i + 1}/${files.length}`;
      status.style.color = color;
    });
    status.textContent = fail ? `完成：成功 ${ok} 个，失败 ${fail} 个` : `完成：成功下载 ${ok} 个`;
    status.style.color = fail ? '#c00' : '#2e8b57';
  }

  // 第二级：勾选文件 → 逐个下载（行内状态）
  async function onDownloadSelectedFiles(panel) {
    const rows = Array.from(panel.querySelectorAll('.rcppt-row')).filter((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      return cb && cb.checked && !cb.disabled;
    });
    if (!rows.length) { alert('未勾选任何文件'); return; }
    const files = rows.map((row) => ({
      classroomId: row.dataset.classroomId,
      resource: {
        resourceId: row.dataset.leafId,
        name: row.dataset.name,
        type: row.dataset.type,
        url: row.dataset.url
      }
    }));
    await downloadFiles(files, (i, text, color) => markRow(rows[i], text, color));
  }

  function onClearCache() {
    if (!confirm('确定清空缓存？该操作不可撤销，下次扫描将全量重新检测。')) return;
    Store.clear();
    browseCache = Logic.emptyCache();
    browseNewKeys = new Set();
    renderCourses();
  }

  // 窗口内扫描：复用 runScan → 刷新列表 + 会话「新」徽标 + 横幅
  async function scanAndRefresh(panel, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      const diff = await runScan();
      consecutiveScanErrors = 0;
      browseCache = Store.load(); // 重新读取更新后的缓存
      diff.addedResources.forEach((item) => {
        browseNewKeys.add(`${item.courseId}:${item.classroomId}:${item.resource.resourceId}`);
      });
      let notice = diff.addedResourceCount
        ? `发现 ${diff.addedResourceCount} 个新课件 / 来自 ${diff.addedCourseCount} 门课`
        : '无新增课件';
      if (diff.failed && diff.failed.length) notice += `；${diff.failed.length} 门课扫描失败已跳过，详情见控制台`;
      renderCourses(notice);
    } catch (err) {
      if (err.message === 'AUTH_EXPIRED') {
        consecutiveScanErrors = 0;
        alert('登录已失效，请重新登录后重试');
      } else {
        consecutiveScanErrors += 1;
        console.error('[雨课堂PPT下载器] 扫描失败', err);
        const hint = consecutiveScanErrors >= 2 ? '接口可能已变更，请在控制台查看详情。' : '';
        alert(hint + '扫描失败：' + err.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '扫描';
    }
  }

  function ensureButton() {
    if (document.querySelector('.rcppt-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'rcppt-btn';
    btn.textContent = '📄 雨课堂PPT下载';
    btn.addEventListener('click', openBrowse);
    document.body.appendChild(btn);
  }

  function closePanel() {
    document.querySelectorAll('.rcppt-mask, .rcppt-panel').forEach((n) => n.remove());
  }

  let consecutiveScanErrors = 0; // Task 9 Step 3：连续失败计数（接口可能已变更）

  // ===== 下载器 + 打印模块（Task 8）：直链下载 / 图片流走打印导出 PDF =====

  function triggerDownload(url, name) {
    return new Promise((resolve) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = name || '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(resolve, 200); // 给浏览器处理下载的时间
    });
  }

  // 统一下载核心（Task：浏览窗口两级复用）：files 来自 collectSelection 或行 dataset
  async function downloadFiles(files, mark) {
    let ok = 0, fail = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const r = f.resource;
      if (mark) mark(i, '下载中…', '#08f');
      try {
        if (r.type === 'img') {
          await Print.exportPdf({ classroomId: f.classroomId, leafId: r.resourceId, name: r.name });
        } else if (r.url) {
          await triggerDownload(r.url, r.name);
        } else {
          throw new Error('无下载地址');
        }
        ok++;
        if (mark) mark(i, '✓', '#2e8b57');
      } catch (e) {
        fail++;
        console.warn('[雨课堂PPT下载器] 下载失败：' + r.name + ' — ' + e.message);
        if (mark) mark(i, '失败', '#c00');
      }
      await sleep(800);
    }
    return { ok, fail };
  }

  function markRow(row, text, color) {
    let status = row.querySelector('.rcppt-status');
    if (!status) {
      status = document.createElement('span');
      status.className = 'rcppt-status';
      row.appendChild(status);
    }
    status.textContent = text;
    status.style.color = color;
  }

  // ===== 打印模块（图片流 → PDF）：CDP 全自动 / 半自动 win.print() 回退 =====

  function uvIdFromCookie() {
    const m = document.cookie.match(/(?:^|;\s*)uv_id=([^;]+)/);
    return m ? m[1] : '';
  }

  const Print = {
    // 探测本机是否有带 --remote-debugging-port=9222 的 Chrome
    async cdpAvailable() {
      try {
        const res = await fetch('http://localhost:9222/json/version', { cache: 'no-store' });
        return res.ok;
      } catch (e) { return false; }
    },

    async exportPdf({ classroomId, leafId, name }) {
      // 懒加载：leaf → courseware_id → presentationId → slideList
      const leafInfo = await Api.fetchLeafInfo(classroomId, leafId, uvIdFromCookie());
      const review = await Api.fetchReview(leafInfo.courseware_id);
      const presentationId = review.timelineList[0].presentationId;
      const slideList = await Api.fetchPpt(leafInfo.courseware_id, presentationId);

      // 写入 rain_print 并打开打印页（数据经 localStorage 传递，无 URL 参数）
      localStorage.setItem('rain_print', JSON.stringify({
        Slides: slideList.map((s) => ({ id: s.id, index: s.index, cover: s.cover, doubtCount: 0, collectCount: 0 })),
        Width: 1920, Height: 1080, Title: name, printType: 'ppt'
      }));
      const win = window.open('/web/print', '_blank');

      if (await this.cdpAvailable()) {
        try {
          await this.cdpPrintToPdf(name); // CDP 全自动
          if (win) win.close();           // 关闭打印页，防止 tab 泄漏
          return;                         // 自动导出成功 → 行标 ✓
        } catch (e) {
          // CDP 失败 → 回退半自动（简报⚠️：任何一步失败回退 win.print()）
          await sleep(2500);
          if (win) { win.print(); return; } // 回退成功：用户另存为 PDF
          throw e;                          // 打印页被弹窗拦截 → 如实标失败
        }
      }
      // 半自动回退：用户另存为 PDF（win 为 null 即弹窗被拦截 → 如实抛错，与 CDP 回退分支一致）
      await sleep(2500);
      if (win) win.print();
      else throw new Error('打印页被浏览器拦截，请允许弹窗后重试');
    },

    // CDP 全自动：经 localhost:9222 WebSocket 调 Page.printToPDF → base64 → Blob 下载
    async cdpPrintToPdf(name) {
      const targets = await (await fetch('http://localhost:9222/json')).json();
      const target = targets.filter((t) => t.type === 'page' && t.url.includes('/web/print')).at(-1);
      if (!target) throw new Error('未找到打印页 tab');
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const base64 = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP 超时')), 30000);
        let sendTimer = null; // Task 9：跟踪内层 2500ms send 定时器，ws 关闭时 clearTimeout 防止 InvalidStateError
        ws.onopen = () => {
          // 等待 /web/print 打印页渲染完成（简报⚠️：printToPDF 前需确认页面已渲染，避免空白/缺页 PDF）
          // 图片渲染约需 1-3s，取 2500ms；整体仍受外层 30s CDP 超时兜底，不引入新悬挂
          sendTimer = setTimeout(() => ws.send(JSON.stringify({
            id: 1, method: 'Page.printToPDF',
            params: { printBackground: true, landscape: true, preferCSSPageSize: true }
          })), 2500);
        };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id === 1) {
            clearTimeout(timer);
            if (m.result && m.result.data) resolve(m.result.data);
            else reject(new Error('CDP 打印失败：' + ((m.error && m.error.message) || '无返回数据')));
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          if (sendTimer) clearTimeout(sendTimer);
          reject(new Error('CDP 连接失败'));
        };
      });
      ws.close();
      // base64 → Blob 下载
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = (name || 'courseware') + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
  };

  function keepAlive() {
    const orig = history.pushState;
    history.pushState = function (...args) {
      const ret = orig.apply(this, args);
      setTimeout(ensureButton, 500);
      return ret;
    };
    new MutationObserver(() => {
      if (document.body && !document.querySelector('.rcppt-btn')) ensureButton();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // 入口初始化
  ensureStyles();
  keepAlive();
  if (document.body) ensureButton();
  else window.addEventListener('DOMContentLoaded', ensureButton);
})();
