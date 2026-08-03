// tests/smoke.test.js
const test = require('node:test');
const assert = require('node:assert');
const RCLogic = require('../src/logic.js');

test('logic module exports expected namespaces', () => {
  assert.ok(RCLogic, 'RCLogic should be exported');
  assert.equal(typeof RCLogic, 'object');
});
