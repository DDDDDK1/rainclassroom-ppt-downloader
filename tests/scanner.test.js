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
});

test('diffCourses 空缓存 → 全部课程视为新增', () => {
  const fetched = [
    {
      courseId: 'c1', courseName: '高数',
      resources: [{ resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1' }]
    }
  ];
  const diff = L.diffCourses(L.emptyCache(), fetched);
  assert.equal(diff.addedCourseCount, 1);
  assert.equal(diff.addedResourceCount, 1);
  assert.equal(diff.addedResources[0].courseId, 'c1');
});

test('diffCourses 已存在课程仅报新增课件', () => {
  const cache = L.emptyCache();
  cache.courses.push({
    courseId: 'c1', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1', scanTime: 1 }],
    scanTime: 1
  });
  const fetched = [
    {
      courseId: 'c1', courseName: '高数',
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
    courseId: 'c1', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '重名.pdf', type: 'pdf', url: 'u1', scanTime: 1 }],
    scanTime: 1
  });
  const fetched = [{
    courseId: 'c1', courseName: '高数',
    resources: [{ resourceId: 'r1', name: '重名.pdf', type: 'pdf', url: 'u1' }]
  }];
  assert.equal(L.diffCourses(cache, fetched).addedResourceCount, 0);
});
