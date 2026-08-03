// tests/store.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

test('emptyCache 返回空结构', () => {
  const c = L.emptyCache();
  assert.equal(c.version, 1);
  assert.deepEqual(c.courses, []);
});

test('parseCache 对非法 JSON 返回空缓存而非抛错', () => {
  const c = L.parseCache('not-json{{{');
  assert.deepEqual(c, L.emptyCache());
});

test('parseCache 序列化往返一致', () => {
  const c = L.emptyCache();
  const restored = L.parseCache(L.serializeCache(c));
  assert.deepEqual(restored, c);
});

test('upsertCourse 新增课程', () => {
  const cache = L.emptyCache();
  const course = { courseId: 'c1', classroomId: 'k1', courseName: '高数', resources: [], scanTime: 1 };
  const next = L.upsertCourse(cache, course);
  assert.equal(next.courses.length, 1);
  assert.equal(next.courses[0].courseName, '高数');
  // 不修改原对象
  assert.equal(cache.courses.length, 0);
});

test('upsertCourse 更新已有课程（同 courseId + 同 classroomId）', () => {
  const cache = L.emptyCache();
  cache.courses.push({ courseId: 'c1', classroomId: 'k1', courseName: '旧名', resources: [], scanTime: 1 });
  const course = { courseId: 'c1', classroomId: 'k1', courseName: '新名', resources: [{ resourceId: 'r1' }], scanTime: 2 };
  const next = L.upsertCourse(cache, course);
  assert.equal(next.courses.length, 1);
  assert.equal(next.courses[0].courseName, '新名');
  assert.equal(next.courses[0].resources.length, 1);
});

test('upsertCourse 同 courseId、不同 classroomId → 两条独立条目', () => {
  const cache = L.emptyCache();
  cache.courses.push({ courseId: 'c1', classroomId: 'k1', courseName: '高数A班', resources: [{ resourceId: 'r1' }], scanTime: 1 });
  const course = { courseId: 'c1', classroomId: 'k2', courseName: '高数B班', resources: [{ resourceId: 'r9' }], scanTime: 2 };
  const next = L.upsertCourse(cache, course);
  assert.equal(next.courses.length, 2);
  // 两条条目按 (courseId, classroomId) 区分，互不覆盖
  assert.deepEqual(
    next.courses.map((c) => c.classroomId).sort(),
    ['k1', 'k2']
  );
  assert.equal(next.courses.find((c) => c.classroomId === 'k1').resources.length, 1);
  assert.equal(next.courses.find((c) => c.classroomId === 'k2').resources.length, 1);
});
