import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelLifecycle } from '../static/model-state.js';
import { separationLayerName } from '../static/layer-names.js';

test('unnamed separations identify their source layer', () => {
  assert.equal(separationLayerName('Layer 2'), 'Separation from Layer 2');
  assert.equal(separationLayerName('Layer 5', '  '), 'Separation from Layer 5');
  assert.equal(separationLayerName('Hair'), 'Separation from Hair');
});
test('explicit separation names take precedence', () => {
  assert.equal(separationLayerName('Layer 2', '  Eye highlights  '), 'Eye highlights');
  assert.equal(separationLayerName('Layer 2', '裤子'), '裤子');
});

test('new models are not exportable before generation', () => {
  const state = new ModelLifecycle();
  assert.equal(state.hasModel, false); assert.equal(state.current, false);
  assert.equal(state.dirty, false); assert.equal(state.generating, false);
});
test('successful generation records the exact geometry revision', () => {
  const state = new ModelLifecycle(), token = state.begin();
  assert.equal(state.generating, true); assert.equal(state.complete(token), true);
  assert.equal(state.current, true); assert.equal(state.generating, false);
});
test('edits retain the previous model but make export stale', () => {
  const state = new ModelLifecycle(); state.complete(state.begin()); state.invalidate();
  assert.equal(state.hasModel, true); assert.equal(state.dirty, true); assert.equal(state.current, false);
});
test('new artwork resets the previous model', () => {
  const state = new ModelLifecycle(); state.complete(state.begin()); state.invalidate(true);
  assert.equal(state.hasModel, false); assert.equal(state.current, false);
});
test('a response from superseded settings must not become current', () => {
  const state = new ModelLifecycle(), token = state.begin(); state.invalidate();
  assert.equal(state.accepts(token), false); assert.equal(state.complete(token), false);
  state.finish(token); assert.equal(state.generating, false); assert.equal(state.current, false);
});
test('updating a stale model makes its latest revision current', () => {
  const state = new ModelLifecycle(); state.complete(state.begin()); state.invalidate();
  const next = state.begin(); assert.equal(state.complete(next), true); assert.equal(state.dirty, false);
});
test('failed regeneration never destroys the previous current result', () => {
  const state = new ModelLifecycle(); state.complete(state.begin()); const token = state.begin(); state.finish(token);
  assert.equal(state.current, true); assert.equal(state.generating, false);
});
