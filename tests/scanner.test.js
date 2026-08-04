// tests/scanner.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

test('classifyResource 识别 pdf / pptx / 图片流 / 其他', () => {
  assert.equal(L.classifyResource({ type: 'pdf' }), 'pdf');
  assert.equal(L.classifyResource({ type: 'pptx' }), 'pptx');
  assert.equal(L.classifyResource({ type: 'ppt' }), 'img'); // ppt 分片预览 → 图片流
  assert.equal(L.classifyResource({ file_type: 'video' }), 'other');
  assert.equal(L.classifyResource({ type: '', url: null }), 'other');
  assert.equal(L.classifyResource({ type: 'img', name: '第3章课件.pdf' }), 'img'); // C1：显式 img 不被 .pdf 后缀覆写
  assert.equal(L.classifyResource({ name: '第3章课件.pdf' }), 'pdf'); // 无 type 时后缀兜底仍生效
  assert.equal(L.classifyResource({ type: 'pdf', name: 'x' }), 'pdf'); // 显式 pdf 仍生效
});

test('diffCourses 空缓存 → 全部课程视为新增', () => {
  const fetched = [
    {
      courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
      resources: [{ resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1' }]
    }
  ];
  const diff = L.diffCourses(L.emptyCache(), fetched);
  assert.equal(diff.addedCourseCount, 1);
  assert.equal(diff.addedResourceCount, 1);
  assert.equal(diff.addedResources[0].courseId, 'c1');
  assert.equal(diff.addedResources[0].classroomId, 'k1');
  assert.equal(diff.addedResources[0].className, '高数A班');
});

test('diffCourses 已存在课程仅报新增课件', () => {
  const cache = L.emptyCache();
  cache.courses.push({
    courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1', scanTime: 1 }],
    scanTime: 1
  });
  const fetched = [
    {
      courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
      resources: [
        { resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1' },
        { resourceId: 'r2', name: '第2章.pdf', type: 'pdf', url: 'u2' }
      ]
    }
  ];
  const diff = L.diffCourses(cache, fetched);
  assert.equal(diff.addedCourseCount, 0);
  assert.equal(diff.addedResourceCount, 1);
  assert.equal(diff.addedResources[0].resource.resourceId, 'r2');
});

test('diffCourses 同 resourceId 重名也判定为已存在', () => {
  const cache = L.emptyCache();
  cache.courses.push({
    courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '重名.pdf', type: 'pdf', url: 'u1', scanTime: 1 }],
    scanTime: 1
  });
  const fetched = [{
    courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '重名.pdf', type: 'pdf', url: 'u1' }]
  }];
  assert.equal(L.diffCourses(cache, fetched).addedResourceCount, 0);
});

test('diffCourses 同 courseId 两个 classroomId → 各自独立计新增', () => {
  const fetched = [
    {
      courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
      resources: [{ resourceId: 'r1', name: 'A章.pdf', type: 'pdf', url: 'u1' }]
    },
    {
      courseId: 'c1', classroomId: 'k2', className: '高数B班', courseName: '高数',
      resources: [{ resourceId: 'r2', name: 'B章.pdf', type: 'pdf', url: 'u2' }]
    }
  ];
  const diff = L.diffCourses(L.emptyCache(), fetched);
  // 每个教室独立计为新课程；两个课件都算新增
  assert.equal(diff.addedCourseCount, 2);
  assert.equal(diff.addedResourceCount, 2);
  assert.deepEqual(
    diff.addedResources.map((a) => a.classroomId).sort(),
    ['k1', 'k2']
  );
});

test('diffCourses 同 courseId+classroomId 重扫 → 无新增', () => {
  const cache = L.emptyCache();
  cache.courses.push({
    courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
    resources: [{ resourceId: 'r1', name: 'A章.pdf', type: 'pdf', url: 'u1', scanTime: 1 }],
    scanTime: 1
  });
  cache.courses.push({
    courseId: 'c1', classroomId: 'k2', className: '高数B班', courseName: '高数',
    resources: [{ resourceId: 'r2', name: 'B章.pdf', type: 'pdf', url: 'u2', scanTime: 1 }],
    scanTime: 1
  });
  const fetched = [
    {
      courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
      resources: [{ resourceId: 'r1', name: 'A章.pdf', type: 'pdf', url: 'u1' }]
    },
    {
      courseId: 'c1', classroomId: 'k2', className: '高数B班', courseName: '高数',
      resources: [{ resourceId: 'r2', name: 'B章.pdf', type: 'pdf', url: 'u2' }]
    }
  ];
  const diff = L.diffCourses(cache, fetched);
  assert.equal(diff.addedCourseCount, 0);
  assert.equal(diff.addedResourceCount, 0);
});
