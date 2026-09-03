// tests/history.test.js
// 扫描历史纯逻辑：空/容错 parse、append（新在前 + 封顶 100）、快照（裁剪 leafInfo、计数）
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

function makeAdded(id, overrides = {}) {
  return {
    courseId: 'c' + id,
    classroomId: 'k' + id,
    courseName: '课' + id,
    className: id % 2 ? 'A班' : 'B班',
    resource: { resourceId: 'r' + id, name: '件' + id, type: 'img', url: null, leafInfo: { leafId: id } },
    ...overrides
  };
}

test('emptyHistory 返回空结构', () => {
  const h = L.emptyHistory();
  assert.deepEqual(h, { version: 1, items: [] });
});

test('parseHistory 非法 JSON / 空串 → 空历史不抛错', () => {
  assert.deepEqual(L.parseHistory('not-json'), L.emptyHistory());
  assert.deepEqual(L.parseHistory(''), L.emptyHistory());
  assert.deepEqual(L.parseHistory(undefined), L.emptyHistory());
  assert.deepEqual(L.parseHistory(null), L.emptyHistory());
});

test('parseHistory 版本不符 / items 非数组 → 空历史', () => {
  assert.deepEqual(L.parseHistory('{"version":99,"items":[]}'), L.emptyHistory());
  assert.deepEqual(L.parseHistory('{"version":1,"items":"x"}'), L.emptyHistory());
  assert.deepEqual(L.parseHistory('{"items":[1]}'), L.emptyHistory()); // version 缺失
});

test('parseHistory 脏条目被丢弃，合法条目保留并重算 fileCount', () => {
  const raw = JSON.stringify({
    version: 1,
    items: [
      { ts: 2, files: [{ courseId: 'c', classroomId: 'k', resource: { resourceId: 'r', name: 'n', type: 'img' } }], courseCount: 9 },
      { files: [] },                                    // 无 ts → 丢
      { ts: 3, files: 'x' },                            // files 非数组 → 丢
      { ts: 4, files: [] }                              // files 空 → 丢
    ]
  });
  const h = L.parseHistory(raw);
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0].ts, 2);
  assert.equal(h.items[0].fileCount, 1);
  assert.equal(h.items[0].courseCount, 1); // 重算，忽略存的 9
});

test('appendHistory 新记录在最前', () => {
  let h = L.emptyHistory();
  h = L.appendHistory(h, { ts: 1, files: [], fileCount: 0, courseCount: 0 });
  h = L.appendHistory(h, { ts: 2, files: [], fileCount: 0, courseCount: 0 });
  assert.deepEqual(h.items.map((i) => i.ts), [2, 1]);
});

test('appendHistory 封顶 100 条，超出丢最旧', () => {
  let h = L.emptyHistory();
  for (let ts = 0; ts < 105; ts++) {
    h = L.appendHistory(h, { ts, files: [], fileCount: 0, courseCount: 0 });
  }
  assert.equal(h.items.length, 100);
  assert.equal(h.items[0].ts, 104);         // 最新在前
  assert.equal(h.items[99].ts, 5);          // 最旧保留到 ts=5，0..4 被丢弃
});

test('snapshotHistoryRecord 裁剪大字段并正确计数', () => {
  const rec = L.snapshotHistoryRecord([makeAdded(1), makeAdded(2)], 1234567);
  assert.equal(rec.ts, 1234567);
  assert.equal(rec.fileCount, 2);
  assert.equal(rec.courseCount, 2);
  const f = rec.files[0];
  assert.equal(f.courseName, '课1');
  assert.equal(f.className, 'A班');
  assert.deepEqual(f.resource, { resourceId: 'r1', name: '件1', type: 'img', url: null }); // leafInfo 已裁
  assert.equal('leafInfo' in f.resource, false);
});

test('snapshotHistoryRecord 同课多文件 → courseCount 去重计数', () => {
  const rec = L.snapshotHistoryRecord([makeAdded(1), makeAdded(1, { resource: { resourceId: 'r9', name: 'x', type: 'img' } })], 1);
  assert.equal(rec.fileCount, 2);
  assert.equal(rec.courseCount, 1);
});

test('snapshotHistoryRecord 空/全脏输入 → null 不记', () => {
  assert.equal(L.snapshotHistoryRecord([], 1), null);
  assert.equal(L.snapshotHistoryRecord(null, 1), null);
  assert.equal(L.snapshotHistoryRecord([{ courseId: 'x' }], 1), null); // 缺 resource → 跳过
  assert.equal(L.snapshotHistoryRecord([makeAdded(1, { classroomId: undefined })], 1), null); // 缺 classroomId → 跳过
});
