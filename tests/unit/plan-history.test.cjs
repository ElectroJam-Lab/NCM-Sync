const test = require('node:test');
const assert = require('node:assert/strict');

test('歌曲方案撤回和重做保持逐曲决定；新修改丢弃旧重做分支', async () => {
  const { createPlanHistory, planHistory } = await import('../../src/renderer/plan-history.mjs');
  let state = createPlanHistory({ first: 'add', second: 'keep' });
  state = planHistory(state, { type: 'move', id: 'first', to: 'keep' });
  state = planHistory(state, { type: 'move', id: 'second', to: 'remove' });
  state = planHistory(state, { type: 'undo' });
  assert.deepEqual(state.targets, { first: 'keep', second: 'keep' });
  state = planHistory(state, { type: 'redo' });
  assert.deepEqual(state.targets, { first: 'keep', second: 'remove' });
  state = planHistory(state, { type: 'undo' });
  state = planHistory(state, { type: 'move', id: 'first', to: 'remove' });
  assert.equal(state.future.length, 0);
  const unchanged = planHistory(state, { type: 'move', id: 'unknown', to: 'add' });
  assert.equal(unchanged, state);
});

test('整批歌曲全选和取消只占一次撤回，撤回恢复各自操作和勾选状态', async () => {
  const { createPlanHistory, planHistory } = await import('../../src/renderer/plan-history.mjs');
  const initial = createPlanHistory({ first: 'add', second: 'remove' }, { first: true, second: true });
  const cleared = planHistory(initial, { type: 'batch', changes: [
    { id: 'first', to: 'keep', enabled: false }, { id: 'second', to: 'keep', enabled: false }
  ] });
  assert.equal(cleared.past.length, 1);
  assert.deepEqual(cleared.enabled, { first: false, second: false });
  const restored = planHistory(cleared, { type: 'undo' });
  assert.deepEqual(restored.targets, initial.targets);
  assert.deepEqual(restored.enabled, initial.enabled);
  assert.deepEqual(planHistory(restored, { type: 'redo' }).enabled, cleared.enabled);
});
