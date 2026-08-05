// ==UserScript==
// @name         长江雨课堂PPT下载器
// @namespace    https://github.com/DDDDDK1/rainclassroom-ppt-downloader
// @version      1.3.0
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

  // ===== 设置存储：GM 存简单配置，IndexedDB 存目录句柄 =====
  const SETTINGS_KEY = 'rcppt_settings';
  const IDB_NAME = 'rcppt';
  const IDB_STORE = 'settings';
  const IDB_HANDLE_KEY = 'rcppt_save_dir';

  const Settings = {
    load() {
      try {
        const raw = GM_getValue(SETTINGS_KEY, '');
        const data = raw ? JSON.parse(raw) : {};
        return { categorize: Boolean(data.categorize) };
      } catch (e) {
        return { categorize: false };
      }
    },
    save(settings) {
      GM_setValue(SETTINGS_KEY, JSON.stringify({ categorize: Boolean(settings.categorize) }));
    }
  };

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const SaveDir = {
    async load() { return idbGet(IDB_HANDLE_KEY); },
    async store(handle) { return idbSet(IDB_HANDLE_KEY, handle); },
    async clear() { return idbDelete(IDB_HANDLE_KEY); }
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
            type: 'img',        // 课堂 PPT 为图片流 → 前端合成 PDF 导出
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
        z-index:2147483647;width:640px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;
        background:#fff;border-radius:10px;padding:16px;font-size:14px;color:#222}
      .rcppt-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #eee}
      .rcppt-badge{padding:1px 6px;border-radius:4px;font-size:12px;color:#fff}
      .rcppt-badge.pdf{background:#2e8b57}.rcppt-badge.pptx{background:#1e6fba}
      .rcppt-badge.img{background:#999}
      .rcppt-row.selected{background:#e8f3ff;box-shadow:inset 3px 0 0 #0088ff}
      .rcppt-badge.new{background:#f5a623}
      .rcppt-browse-top{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:600;flex:none}
      .rcppt-browse-top .rcppt-scan{margin-left:auto;font-weight:400}
      .rcppt-browse-title{margin-right:auto;font-weight:600}
      .rcppt-list{flex:1;min-height:0;overflow:auto}
      .rcppt-bottom{flex:none;display:flex;gap:8px;margin-top:12px}
      .rcppt-empty{text-align:center;padding:28px 0;color:#888}
      .rcppt-notice{padding:8px 10px;background:#fff8e1;border:1px solid #ffd54f;border-radius:6px;margin-bottom:8px;color:#6d4c00}
      .rcppt-count{color:#999;font-size:12px}
      .rcppt-status-line{padding:4px 0;font-size:13px}
      .rcppt-course{cursor:pointer}
      .rcppt-panel input[type=checkbox]{-webkit-appearance:auto;appearance:auto;width:16px;height:16px;margin:0;flex:none;opacity:1;position:static}
    `;
    document.head.appendChild(style);
  }

  // ===== 浏览窗口（统一中心）状态 =====
  let browseCache = null;               // 浏览窗口的缓存快照（内存中，不写回）
  let browseNewKeys = new Set();        // 会话级「新」徽标：'courseId:classroomId:resourceId'
  let scanning = false;                 // 全局扫描互斥：两个「扫描」按钮共用

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
    title.className = 'rcppt-browse-title';
    title.textContent = '📚 已扫描课件';
    const btnScan = document.createElement('button');
    btnScan.className = 'rcppt-scan';
    btnScan.textContent = '扫描';
    btnScan.addEventListener('click', () => scanAndRefresh(panel, btnScan));
    const btnSettings = document.createElement('button');
    btnSettings.textContent = '⚙';
    btnSettings.title = '设置';
    btnSettings.addEventListener('click', renderSettings);
    top.append(title, btnScan, btnSettings);
    panel.appendChild(top);

    if (notice) {
      const banner = document.createElement('div');
      banner.className = 'rcppt-notice';
      banner.textContent = notice;
      panel.appendChild(banner);
    }

    if (!browseCache.courses.length) {
      const list = document.createElement('div');
      list.className = 'rcppt-list';
      const empty = document.createElement('div');
      empty.className = 'rcppt-empty';
      empty.textContent = '暂无已扫描课件';
      const btnStart = document.createElement('button');
      btnStart.className = 'rcppt-scan';
      btnStart.textContent = '开始扫描';
      btnStart.addEventListener('click', () => scanAndRefresh(panel, btnStart));
      list.append(empty, btnStart);
      panel.appendChild(list);
    } else {
      const list = document.createElement('div');
      list.className = 'rcppt-list';
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
    bar.className = 'rcppt-bottom';
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
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClose);
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
    title.className = 'rcppt-browse-title';
    title.textContent = course.className ? `${course.courseName} (${course.className})` : course.courseName;
    const btnSettings = document.createElement('button');
    btnSettings.textContent = '⚙';
    btnSettings.title = '设置';
    btnSettings.addEventListener('click', renderSettings);
    top.append(btnBack, title, btnSettings);
    panel.appendChild(top);

    const list = document.createElement('div');
    list.className = 'rcppt-list';
    course.resources.forEach((resource, i) => {
      const row = document.createElement('div');
      row.className = 'rcppt-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.index = String(i);
      cb.disabled = resource.type === 'other';
      const badge = document.createElement('span');
      badge.className = 'rcppt-badge ' + resource.type;
      badge.textContent = resource.type === 'pdf' ? 'PDF' : resource.type === 'pptx' ? 'PPTX' : 'PPT(PDF)';
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
      row.dataset.courseName = course.courseName;
      row.dataset.className = course.className || '';
      row.dataset.leafId = resource.resourceId;
      cb.addEventListener('change', () => row.classList.toggle('selected', cb.checked));
      list.appendChild(row);
    });
    panel.appendChild(list);

    const bar = document.createElement('div');
    bar.className = 'rcppt-bottom';
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
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClose);
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
      courseName: row.dataset.courseName,
      className: row.dataset.className,
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

  function renderSettings() {
    closePanel();
    const mask = document.createElement('div');
    mask.className = 'rcppt-mask';
    const panel = document.createElement('div');
    panel.className = 'rcppt-panel';
    panel.style.width = '440px';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:12px';
    title.textContent = '⚙ 设置';
    panel.appendChild(title);

    // 保存目录
    const dirSection = document.createElement('div');
    dirSection.style.cssText = 'margin-bottom:16px';
    const dirLabel = document.createElement('div');
    dirLabel.textContent = '📂 保存目录';
    const dirInfo = document.createElement('div');
    dirInfo.className = 'rcppt-count';
    dirInfo.textContent = '未选择（下载将保存到浏览器默认目录）';
    SaveDir.load().then((h) => { if (h) dirInfo.textContent = '当前：' + h.name; }).catch(() => {});
    const dirBtns = document.createElement('div');
    const btnPick = document.createElement('button');
    btnPick.textContent = '选择目录';
    btnPick.addEventListener('click', onPickDirectory);
    const btnClearDir = document.createElement('button');
    btnClearDir.textContent = '清除目录';
    btnClearDir.addEventListener('click', onClearDirectory);
    dirBtns.append(btnPick, btnClearDir);
    dirSection.append(dirLabel, dirInfo, dirBtns);
    panel.appendChild(dirSection);

    // 分类下载
    const catSection = document.createElement('div');
    catSection.style.cssText = 'margin-bottom:16px';
    const catLabel = document.createElement('div');
    catLabel.textContent = '📂 分类下载';
    const catRow = document.createElement('label');
    catRow.style.cssText = 'display:flex;align-items:center;gap:8px';
    const catCb = document.createElement('input');
    catCb.type = 'checkbox';
    catCb.checked = Settings.load().categorize;
    const catText = document.createElement('span');
    catText.textContent = '按课程自动创建文件夹（课程名（班级名））';
    const catHint = document.createElement('span');
    catHint.className = 'rcppt-count';
    catRow.append(catCb, catText, catHint);
    catCb.addEventListener('change', () => Settings.save({ categorize: catCb.checked }));
    catSection.append(catLabel, catRow);
    panel.appendChild(catSection);
    SaveDir.load().then((h) => {
      if (!h) { catCb.disabled = true; catText.style.color = '#999'; catHint.textContent = '需先选择保存目录'; }
    }).catch(() => { catCb.disabled = true; catHint.textContent = '需先选择保存目录'; });

    // 清空缓存
    const cacheSection = document.createElement('div');
    cacheSection.style.cssText = 'margin-bottom:16px';
    const cacheLabel = document.createElement('div');
    cacheLabel.textContent = '🧹 清空缓存';
    const btnClear = document.createElement('button');
    btnClear.textContent = '清空缓存';
    btnClear.addEventListener('click', onClearCache);
    cacheSection.append(cacheLabel, btnClear);
    panel.appendChild(cacheSection);

    // 关闭
    const bar = document.createElement('div');
    bar.className = 'rcppt-bottom';
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.appendChild(btnClose);
    panel.appendChild(bar);

    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.append(mask, panel);
  }

  async function onPickDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      alert('当前浏览器不支持自定义保存目录（需 Chrome/Edge）');
      return;
    }
    try {
      const handle = await window.showDirectoryPicker();
      await SaveDir.store(handle);
      renderSettings(); // 重渲染刷新「当前：目录名」
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('选择目录失败：' + (e.message || e));
    }
  }

  async function onClearDirectory() {
    await SaveDir.clear();
    renderSettings();
  }

  // 窗口内扫描：复用 runScan → 刷新列表 + 会话「新」徽标 + 横幅
  async function scanAndRefresh(panel, btn) {
    if (scanning || btn.disabled) return;
    scanning = true;
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
      scanning = false;
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

  // ===== 下载器（Task 8）：直链下载 / 图片流走前端合成 PDF =====

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

  // 直链文件名：从 URL 推导；无扩展名按类型补全（修复待办 #7）
  function urlBase(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(last);
    } catch (e) { return ''; }
  }
  function directFilename(name, url, type) {
    let base = Logic.sanitizeFilename(name || urlBase(url) || 'courseware');
    if (!/\.(pdf|pptx|ppt)$/i.test(base)) base += type === 'pptx' ? '.pptx' : '.pdf';
    return base;
  }

  async function fetchAsBlob(url) {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.blob();
  }

  // 目录句柄是否可用（含授权）；不可用返回 null（无 showDirectoryPicker / 无句柄 / 授权被拒）
  async function saveDirReady() {
    if (typeof window.showDirectoryPicker !== 'function') return null;
    let handle;
    try { handle = await SaveDir.load(); } catch (e) { return null; }
    if (!handle) return null;
    try {
      const opts = { mode: 'readwrite' };
      let perm = await handle.queryPermission(opts);
      if (perm !== 'granted') perm = await handle.requestPermission(opts);
      return perm === 'granted' ? handle : null;
    } catch (e) { return null; }
  }

  // FileSystem 写入：分类时先建课程子文件夹
  async function writeFileToDir(dirHandle, filename, blob, courseFolder) {
    let target = dirHandle;
    if (courseFolder) target = await dirHandle.getDirectoryHandle(courseFolder, { create: true });
    const fileHandle = await target.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  // 交付 blob：目录可用 → 写入；否则 objectURL 原生下载
  async function deliverBlob(dirHandle, settings, course, blob, filename) {
    if (!dirHandle) {
      const url = URL.createObjectURL(blob);
      await triggerDownload(url, filename);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }
    const courseFolder = settings.categorize ? Logic.courseFolderName(course.courseName, course.className) : null;
    await writeFileToDir(dirHandle, filename, blob, courseFolder);
  }

  // 统一下载核心（Task：浏览窗口两级复用）：files 来自 collectSelection 或行 dataset；批次决策目录路由
  async function downloadFiles(files, mark) {
    let ok = 0, fail = 0;
    const dirHandle = await saveDirReady();
    const settings = Settings.load();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const r = f.resource;
      if (!r) { fail++; if (mark) mark(i, '失败', '#c00'); continue; }
      if (mark) mark(i, '下载中…', '#08f');
      try {
        if (r.type === 'img') {
          const { blob, failed } = await buildSlidesPdfBlob(
            { classroomId: f.classroomId, leafId: r.resourceId },
            (done, total) => { if (mark) mark(i, '拉取图片 ' + done + '/' + total, '#08f'); }
          );
          const filename = Logic.sanitizeFilename(r.name) + '.pdf';
          await deliverBlob(dirHandle, settings, { courseName: f.courseName, className: f.className }, blob, filename);
          ok++;
          if (mark) mark(i, failed > 0 ? '✓（' + failed + ' 页失败）' : '✓', '#2e8b57');
        } else if (r.url) {
          const filename = directFilename(r.name, r.url, r.type);
          if (dirHandle) {
            // 目录模式：fetch 写入；CORS/网络失败 → 记录原因并回退原生下载（标灰提示，避免误导进了所选目录）
            const blob = await fetchAsBlob(r.url).catch((e) => {
              console.warn('[雨课堂PPT下载器] 直链拉取失败，已回退默认目录：' + r.name + ' — ' + (e && e.message || e));
              return null;
            });
            if (blob) {
              await deliverBlob(dirHandle, settings, { courseName: f.courseName, className: f.className }, blob, filename);
              ok++;
              if (mark) mark(i, '✓', '#2e8b57');
            } else {
              await triggerDownload(r.url, filename);
              ok++;
              if (mark) mark(i, '✓（已转默认目录）', '#999');
            }
          } else {
            await triggerDownload(r.url, filename);
            ok++;
            if (mark) mark(i, '✓', '#2e8b57');
          }
        } else {
          throw new Error('无下载地址');
        }
      } catch (e) {
        fail++;
        if (e && e.isNoCourseware) {
          console.warn('[雨课堂PPT下载器] 此课堂无文件：' + r.name);
          if (mark) mark(i, '此课堂无文件', '#999');
        } else {
          console.warn('[雨课堂PPT下载器] 下载失败：' + r.name + ' — ' + e.message);
          if (mark) mark(i, '失败', '#c00');
        }
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

  // ===== 图片流 → 前端合成 PDF（完全替换旧打印页/CDP）：fetch 封面 → 手写 PDF → Blob 下载 =====

  function uvIdFromCookie() {
    const m = document.cookie.match(/(?:^|;\s*)uv_id=([^;]+)/);
    return m ? m[1] : '';
  }

  // 拉取单页封面字节。关键：credentials:'omit'（CDN 允许跨域但拒绝带凭据）；20s 超时 + 重试一次
  async function fetchSlideBytes(cover) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(cover, { mode: 'cors', credentials: 'omit', signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.blob();
      } catch (err) {
        lastErr = err && err.name === 'AbortError' ? new Error('拉取超时') : err;
        if (attempt === 0) await sleep(1000);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // 归一化为可直接嵌入 PDF 的 JPEG 字节 + 尺寸：JPEG 直取（SOF 解析），其余经 canvas 转 JPEG
  async function normalizeSlidePage(blob) {
    if (blob.type === 'image/jpeg') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const dim = Logic.jpegDimensions(bytes);
      return { bytes, width: dim.width, height: dim.height };
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('图片解码失败'));
        im.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const jpeg = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 编码失败'))), 'image/jpeg', 0.92);
      });
      return { bytes: new Uint8Array(await jpeg.arrayBuffer()), width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 并发拉取全部页面（上限 5），逐页失败隔离；返回 { pages, failed }
  async function fetchSlidePages(slideList, onProgress) {
    const results = new Array(slideList.length).fill(null);
    let failed = 0;
    let done = 0;
    let next = 0;
    const total = slideList.length;
    const limit = 5;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= total) return;
        try {
          results[i] = await normalizeSlidePage(await fetchSlideBytes(slideList[i].cover));
        } catch (err) {
          failed++;
          console.warn('[雨课堂PPT下载器] 第 ' + (i + 1) + '/' + total + ' 页拉取失败：' + (err.message || err));
        }
        done++;
        if (onProgress) onProgress(done, total);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, total) }, () => worker()));
    const pages = results.filter(Boolean);
    if (!pages.length) throw new Error('全部 ' + total + ' 页拉取失败');
    return { pages, failed };
  }

  // 编排：API 懒加载链 → 拉取页面 → 合成 PDF；返回 { blob, failed }
  async function buildSlidesPdfBlob({ classroomId, leafId }, onProgress) {
    const leafInfo = await Api.fetchLeafInfo(classroomId, leafId, uvIdFromCookie());
    if (!leafInfo.courseware_id) throw Logic.coursewareNoFileError();
    const review = await Api.fetchReview(leafInfo.courseware_id);
    if (!review || !review.timelineList || !review.timelineList.length) throw Logic.coursewareNoFileError();
    const presentationId = review.timelineList[0].presentationId;
    const slideList = await Api.fetchPpt(leafInfo.courseware_id, presentationId);
    if (!slideList || !slideList.length) throw Logic.coursewareNoFileError();
    const { pages, failed } = await fetchSlidePages(slideList, onProgress);
    const pdf = Logic.buildSlidesPdf(pages);
    return { blob: new Blob([pdf], { type: 'application/pdf' }), failed };
  }

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
