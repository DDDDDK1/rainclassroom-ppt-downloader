// tests/selection.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

function makeCache() {
  return {
    version: 1,
    courses: [
      {
        courseId: 'c1', classroomId: 'k1', className: '高数A班', courseName: '高数',
        resources: [
          { resourceId: 'r1', name: '第1章.pdf', type: 'pdf', url: 'u1' },
          { resourceId: 'r2', name: '第2章.pdf', type: 'pdf', url: 'u2' }
        ],
        scanTime: 1
      },
      {
        courseId: 'c1', classroomId: 'k2', className: '高数B班', courseName: '高数',
        resources: [{ resourceId: 'r3', name: '第3章.pdf', type: 'pdf', url: 'u3' }],
        scanTime: 1
      }
    ]
  };
}

test('collectSelection 只传 courseRefs → 展开该课全部资源', () => {
  const files = L.collectSelection(makeCache(), [{ courseId: 'c1', classroomId: 'k1' }], null);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.resource.resourceId).sort(), ['r1', 'r2']);
  assert.equal(files[0].courseName, '高数');
  assert.equal(files[0].className, '高数A班');
});

test('collectSelection 只传 resourceRefs → 返回具体文件', () => {
  const files = L.collectSelection(makeCache(), null, [{ courseId: 'c1', classroomId: 'k2', resourceId: 'r3' }]);
  assert.equal(files.length, 1);
  assert.equal(files[0].resource.resourceId, 'r3');
});

test('collectSelection 两级混合 → 去重合并（同一文件不重复）', () => {
  const files = L.collectSelection(
    makeCache(),
    [{ courseId: 'c1', classroomId: 'k1' }],
    [{ courseId: 'c1', classroomId: 'k1', resourceId: 'r1' }]
  );
  assert.equal(files.length, 2); // r1 在课程展开与具体引用中只出现一次
});

test('collectSelection 未知引用 → 忽略不报错', () => {
  const files = L.collectSelection(
    makeCache(),
    [{ courseId: 'nope', classroomId: 'x' }],
    [{ courseId: 'c1', classroomId: 'k1', resourceId: 'no-such' }]
  );
  assert.equal(files.length, 0);
});

test('collectSelection 空输入 → 空数组', () => {
  assert.deepEqual(L.collectSelection(makeCache(), null, null), []);
  assert.deepEqual(L.collectSelection(makeCache(), [], []), []);
});
