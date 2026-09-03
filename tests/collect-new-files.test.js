// tests/collect-new-files.test.js
// 一级「选中新增」数据源 collectNewFiles：本次新增课件按文件聚合（精确到新增件，不含旧件）
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

// 与 collectNewFiles 内部 / collectSelection 相同的 key 格式
function keyOf(course, resource) {
  return course.courseId + ':' + course.classroomId + ':' + resource.resourceId;
}

function makeCache() {
  return {
    version: 1,
    courses: [
      {
        courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
        resources: [
          { resourceId: 'r1', name: '第1章', type: 'img', url: null },
          { resourceId: 'r2', name: '第2章', type: 'img', url: null },
          { resourceId: 'r3', name: '第3章', type: 'img', url: null }
        ],
        scanTime: 1
      },
      {
        courseId: 'c1', classroomId: 'k2', className: '高数B班', courseName: '高数',
        resources: [{ resourceId: 'r4', name: '第1章', type: 'pdf', url: 'u4' }],
        scanTime: 1
      }
    ]
  };
}

function keysFor(cache, ids) {
  const map = new Map();
  cache.courses.forEach((c) => c.resources.forEach((r) => map.set(r.resourceId, { c, r })));
  return new Set(ids.map((id) => keyOf(map.get(id).c, map.get(id).r)));
}

test('collectNewFiles 无新增 → []', () => {
  assert.deepEqual(L.collectNewFiles(makeCache(), new Set()), []);
});

test('collectNewFiles 单课部分新增 → 只含命中文件，不含旧件', () => {
  const cache = makeCache();
  const keys = keysFor(cache, ['r2']);
  const files = L.collectNewFiles(cache, keys);
  assert.equal(files.length, 1);
  assert.equal(files[0].resource.resourceId, 'r2');
  assert.equal(files[0].resource.name, '第2章');
  assert.equal(files[0].courseName, '高数');
  assert.equal(files[0].className, '高数A班');
});

test('collectNewFiles 多课聚合 → 按 cache 顺序、含 courseName/className', () => {
  const cache = makeCache();
  const keys = keysFor(cache, ['r2', 'r3', 'r4']);
  const files = L.collectNewFiles(cache, keys);
  assert.deepEqual(files.map((f) => f.resource.resourceId), ['r2', 'r3', 'r4']);
  assert.equal(files[2].className, '高数B班');
  assert.equal(files[2].resource.type, 'pdf');
  assert.equal(files[2].resource.url, 'u4');
});

test('collectNewFiles 多教室同名课程只认本教室新增', () => {
  const cache = makeCache();
  const keys = keysFor(cache, ['r4']); // c1:k2 的新增
  const files = L.collectNewFiles(cache, keys);
  assert.equal(files.length, 1);
  assert.equal(files[0].classroomId, 'k2'); // 不把 c1:k1 的 r1/r2/r3 卷进来
});

test('collectNewFiles 非法入参 → [] 不抛错', () => {
  assert.deepEqual(L.collectNewFiles(null, new Set()), []);
  assert.deepEqual(L.collectNewFiles({ courses: null }, new Set()), []);
  assert.deepEqual(L.collectNewFiles(makeCache(), null), []);
  assert.deepEqual(L.collectNewFiles(makeCache(), 'not-a-set'), []);
});

test('collectNewFiles 未知 resourceId 命中 → 忽略（collectSelection 裁剪）', () => {
  const cache = makeCache();
  const keys = keysFor(cache, ['r2']);
  keys.add('c9:k9:no-such');
  const files = L.collectNewFiles(cache, keys);
  assert.equal(files.length, 1);
  assert.equal(files[0].resource.resourceId, 'r2');
});
