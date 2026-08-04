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

    for (const course of courses) {
      // 每课：课程详情(拿 course_sign/uv_id) → chapter(拿 leaf)
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

    return diff;
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
    `;
    document.head.appendChild(style);
  }

  function ensureButton() {
    if (document.querySelector('.rcppt-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'rcppt-btn';
    btn.textContent = '📄 雨课堂PPT下载';
    btn.addEventListener('click', onScanClick);
    document.body.appendChild(btn);
  }

  function showPanel(diff) {
    closePanel();
    const mask = document.createElement('div');
    mask.className = 'rcppt-mask';
    const panel = document.createElement('div');
    panel.className = 'rcppt-panel';
    panel.innerHTML = ''; // 静态骨架用模板，动态课件名一律 textContent

    const summary = document.createElement('div');
    summary.textContent = `发现 ${diff.addedResourceCount} 个新课件 / 来自 ${diff.addedCourseCount} 门课`;
    panel.appendChild(summary);

    const list = document.createElement('div');
    diff.addedResources.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'rcppt-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.index = String(i);
      cb.disabled = item.resource.type === 'other'; // 仅 other 禁用；img 可勾选（下载走打印导出 PDF）
      const badge = document.createElement('span');
      badge.className = 'rcppt-badge ' + item.resource.type;
      badge.textContent = item.resource.type === 'pdf' ? 'PDF' : item.resource.type === 'pptx' ? 'PPTX' : 'PPT(打印)';
      const name = document.createElement('span');
      name.textContent = item.resource.name; // textContent，防注入
      const course = document.createElement('span');
      // 同一课程跨多教室（如"中医学(S6)"5 个教室）→ 展示教室名加以区分（textContent 拼接）
      course.textContent = item.className ? `${item.courseName} (${item.className})` : item.courseName;
      if (item.resource.type === 'img') {
        row.title = '分片图片课件，下载时自动通过打印功能导出 PDF';
      }
      // Task 8：行 dataset 供下载/打印链路读取（classroomId 用真实 classroom_id，≠ courseId）
      row.dataset.url = item.resource.url || '';
      row.dataset.name = item.resource.name;
      row.dataset.type = item.resource.type;
      row.dataset.classroomId = item.classroomId;        // 真实 classroom_id
      row.dataset.leafId = item.resource.resourceId;     // leaf id
      row.append(cb, badge, name, course);
      list.appendChild(row);
    });
    panel.appendChild(list);

    // 操作区：全选 / 下载选中 / 关闭
    const bar = document.createElement('div');
    const btnSelectAll = document.createElement('button');
    btnSelectAll.textContent = '全选';
    btnSelectAll.addEventListener('click', () => {
      // 全选：勾选所有未禁用的复选框
      panel.querySelectorAll('.rcppt-row input[type="checkbox"]').forEach((cb) => {
        if (!cb.disabled) cb.checked = true;
      });
    });
    const btnDownload = document.createElement('button');
    btnDownload.textContent = '下载选中';
    btnDownload.addEventListener('click', () => onDownloadClick(panel)); // Task 8 实现下载逻辑
    const btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', closePanel);
    bar.append(btnSelectAll, btnDownload, btnClose);
    panel.appendChild(bar);

    const notice = document.createElement('div');
    notice.textContent = '课件版权归授课教师所有，仅供个人学习使用，请勿传播';
    panel.appendChild(notice);

    mask.appendChild(panel);
    mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    document.body.append(mask, panel);
  }

  function closePanel() {
    document.querySelectorAll('.rcppt-mask, .rcppt-panel').forEach((n) => n.remove());
  }

  async function onScanClick() {
    const btn = document.querySelector('.rcppt-btn');
    if (btn.disabled) return; // 防重复
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      const diff = await runScan();
      if (diff.addedResourceCount === 0) {
        alert('无新增课件');
        return;
      }
      showPanel(diff);
    } catch (err) {
      alert(err.message === 'AUTH_EXPIRED' ? '登录已失效，请重新登录后重试' : '扫描失败：' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📄 雨课堂PPT下载';
    }
  }

  // ===== 下载器 + 打印模块（Task 8）：直链下载 / 图片流走打印导出 PDF =====

  async function onDownloadClick(panel) {
    const rows = panel.querySelectorAll('.rcppt-row');
    const targets = Array.from(rows).filter((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      return cb && cb.checked && !cb.disabled;
    });

    for (const row of targets) {
      const type = row.dataset.type;
      const name = row.dataset.name;
      markRow(row, '下载中…', '#08f');
      try {
        if (type === 'img') {
          await Print.exportPdf(row);          // 图片流 → 打印模块（CDP 全自动/半自动回退）
        } else if (row.dataset.url) {
          await triggerDownload(row.dataset.url, name);
        } else {
          throw new Error('无下载地址');
        }
        markRow(row, '✓', '#2e8b57');
      } catch (e) {
        markRow(row, '失败', '#c00');
      }
      await sleep(800);
    }
  }

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

    async exportPdf(row) {
      const classroomId = row.dataset.classroomId;
      const leafId = row.dataset.leafId;
      const name = row.dataset.name;
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
          return;                         // 自动导出成功 → 行标 ✓
        } catch (e) {
          // CDP 失败 → 回退半自动（简报⚠️：任何一步失败回退 win.print()）
          await sleep(2500);
          if (win) { win.print(); return; } // 回退成功：用户另存为 PDF
          throw e;                          // 打印页被弹窗拦截 → 如实标失败
        }
      }
      // 半自动回退：用户另存为 PDF
      await sleep(2500);
      if (win) win.print();
    },

    // CDP 全自动：经 localhost:9222 WebSocket 调 Page.printToPDF → base64 → Blob 下载
    async cdpPrintToPdf(name) {
      const targets = await (await fetch('http://localhost:9222/json')).json();
      const target = targets.find((t) => t.type === 'page' && t.url.includes('/web/print'));
      if (!target) throw new Error('未找到打印页 tab');
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const base64 = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP 超时')), 30000);
        ws.onopen = () => {
          // 等待 /web/print 打印页渲染完成（简报⚠️：printToPDF 前需确认页面已渲染，避免空白/缺页 PDF）
          // 图片渲染约需 1-3s，取 2500ms；整体仍受外层 30s CDP 超时兜底，不引入新悬挂
          setTimeout(() => ws.send(JSON.stringify({
            id: 1, method: 'Page.printToPDF',
            params: { printBackground: true, landscape: true, preferCSSPageSize: true }
          })), 2500);
        };
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(timer); resolve(m.result.data); } };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
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
