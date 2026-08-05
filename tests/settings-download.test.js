// tests/settings-download.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/logic.js');

test('courseFolderName 有班级名 → 课程名（班级名）', () => {
  assert.equal(L.courseFolderName('高等数学', '高数A班'), '高等数学（高数A班）');
});

test('courseFolderName 无班级名 → 仅课程名', () => {
  assert.equal(L.courseFolderName('高等数学', ''), '高等数学');
  assert.equal(L.courseFolderName('高等数学', null), '高等数学');
  assert.equal(L.courseFolderName('高等数学', undefined), '高等数学');
});

test('courseFolderName 非法字符被净化', () => {
  assert.equal(L.courseFolderName('a/b\\c:d', 'x/y'), 'a_b_c_d（x_y）');
});

test('courseFolderName 空课程名 → 回退 courseware', () => {
  assert.equal(L.courseFolderName('', ''), 'courseware');
});

test('coursewareNoFileError 返回结构正确', () => {
  const e = L.coursewareNoFileError();
  assert.ok(e instanceof Error);
  assert.equal(e.message, '此课堂无文件');
  assert.equal(e.isNoCourseware, true);
});
