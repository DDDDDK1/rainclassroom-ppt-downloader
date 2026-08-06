// tests/course-has-new.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

// 与 app.js keyOf / logic.collectSelection 相同的 key 格式
function keyOf(course, resource) {
  return course.courseId + ':' + course.classroomId + ':' + resource.resourceId;
}

function makeCourse(overrides = {}) {
  return {
    courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
    resources: [
      { resourceId: 'r1', name: '第1章', type: 'img', url: null },
      { resourceId: 'r2', name: '第2章', type: 'img', url: null }
    ],
    scanTime: 1,
    ...overrides
  };
}

test('courseHasNew 部分新增 → true', () => {
  const course = makeCourse();
  const keys = new Set([keyOf(course, course.resources[0])]);
  assert.equal(L.courseHasNew(course, keys), true);
});

test('courseHasNew 全部新增 → true', () => {
  const course = makeCourse();
  const keys = new Set(course.resources.map((r) => keyOf(course, r)));
  assert.equal(L.courseHasNew(course, keys), true);
});

test('courseHasNew 无新增 → false', () => {
  const course = makeCourse();
  const keys = new Set(['c1:k1:r9']); // 无命中
  assert.equal(L.courseHasNew(course, keys), false);
});

test('courseHasNew 空课程（resources=[]）→ false', () => {
  const course = makeCourse({ resources: [] });
  const keys = new Set();
  assert.equal(L.courseHasNew(course, keys), false);
});

test('courseHasNew 非法入参不抛错 → false', () => {
  assert.equal(L.courseHasNew(null, new Set()), false);
  assert.equal(L.courseHasNew(makeCourse({ resources: null }), new Set()), false);
  assert.equal(L.courseHasNew(makeCourse(), null), false);
  assert.equal(L.courseHasNew(makeCourse(), 'not-a-set'), false);
});

test('courseHasNew 多教室同名课程只认本教室新增', () => {
  const course = makeCourse({ classroomId: 'k1' });
  const other = { courseId: 'c1', classroomId: 'k2', resources: [{ resourceId: 'r1' }] };
  const keys = new Set([keyOf(other, other.resources[0])]); // c1:k2:r1
  assert.equal(L.courseHasNew(course, keys), false); // 不误判 k1
});
