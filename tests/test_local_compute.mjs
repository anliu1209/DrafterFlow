import test from 'node:test';
import assert from 'node:assert/strict';
import Module from '../static/vendor/manifold.js';
import { analyzePixels, connectedRegions, resolveLayers, traceMask } from '../static/local-color-core.js';
import { buildLocalColorModel, closedMesh } from '../static/local-color-model.js';
import { LocalCompute, localComputeSupported } from '../static/local-compute.js';
const api = await Module(); api.setup();
const pixelImage = (w, h, fn) => { const data = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4); return data; };
const fixture = () => {
  const w = 24, h = 20;
  const data = pixelImage(w, h, (x, y) => x < 2 || x > 21 || y < 2 || y > 17 ? [0, 0, 0, 0] : y < 6 ? [240, 240, 250, 255] : x < 9 ? [250, 200, 200, 255] : y > 14 ? [170, 190, 230, 255] : x === 14 && y === 10 ? [240, 240, 250, 255] : x < 17 ? [60, 65, 85, 255] : [250, 235, 225, 255]);
  return analyzePixels(data, w, h, { palette_size: 5 });
};
const layers = a => a.palette.map(p => ({ id: p.id, source_color_id: p.id, region_seeds: null }));
test('five flat colours remain distinct; a one-pixel white highlight survives', () => {
  const a = fixture(); assert.equal(a.palette.length, 5); assert.equal(a.w_px, 20); assert.equal(a.h_px, 16);
  assert.ok(a.regions.some(r => r.pixel_count === 1)); assert.equal(a.background_id, null);
});
test('four-connected components and diagonal boundary rings are independent', () => {
  const a = new Int16Array([0, -1, -1, 0]);
  assert.equal(connectedRegions(a, 2, 2, 1).regions.length, 2);
  assert.equal(traceMask(new Uint8Array([1, 0, 0, 1]), 2, 2).length, 2);
  assert.equal(traceMask(new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3).length, 2);
});
test('remove edge-connected white background without removing enclosed white', () => {
  const data = pixelImage(9, 9, (x, y) => x < 2 || x > 6 || y < 2 || y > 6 || x === 4 && y === 4 ? [255, 255, 255, 255] : [30, 40, 60, 255]);
  const a = analyzePixels(data, 9, 9, { palette_size: 2, remove_background: true });
  assert.equal(a.background_removed, true); assert.equal(a.background_pixel_count, 56);
  assert.ok(a.regions.some(r => r.color_id === a.background_id && r.pixel_count === 1));
});
test('same pigment splits into complementary height groups and rejects overlap', () => {
  const a = fixture(), white = a.regions.find(r => r.pixel_count === 1), initial = layers(a);
  const original = initial.find(l => l.id === white.color_id); original.excluded_region_seeds = [white.seed];
  initial.push({ id: 'highlight', source_color_id: white.color_id, region_seeds: [white.seed] });
  assert.equal(resolveLayers(a, initial).length, 6);
  const model = buildLocalColorModel(api, a, { width: 40, base: .4, increment: .2, layers: initial });
  assert.equal(model.final_heights.length, 6); assert.ok(model.triangle_count > 0);
  original.excluded_region_seeds = []; assert.throws(() => resolveLayers(a, initial), /two layers/);
});
test('local STL is closed after reordering, custom heights, and repeated cached edits', () => {
  const a = fixture(), ordered = layers(a).reverse(), cache = new Map(); ordered[0].height_mm = .6;
  const options = { layers: ordered, width: 40, base: .8, increment: .2 };
  const first = buildLocalColorModel(api, a, options, cache);
  assert.ok(Math.abs(first.final_heights.at(-1) - 2.2) < 1e-6); assert.ok(first.triangle_count > 0);
  assert.equal(first.stl.byteLength, 84 + first.triangle_count * 50);
  const size = cache.size, second = buildLocalColorModel(api, a, { ...options, base: 1.2 }, cache);
  assert.equal(cache.size, size); assert.ok(Math.abs(second.final_heights.at(-1) - 2.6) < 1e-6);
});
test('thick external hole tab remains closed; detached tabs are rejected', () => {
  const a = fixture(), options = { layers: layers(a), width: 40, base: .4, increment: .2 };
  const result = buildLocalColorModel(api, a, { ...options, base_hole: { x: 0, y: 16.5, diameter: 3, height: 3 } });
  assert.ok(result.stl.byteLength > 84);
  const view = new DataView(result.stl); let top = 0;
  for (let t = 0; t < result.triangle_count; t++) for (let j = 0; j < 3; j++) top = Math.max(top, view.getFloat32(84 + t * 50 + 12 + j * 12 + 8, true));
  assert.equal(top, 3);
  assert.throws(() => buildLocalColorModel(api, a, { ...options, base_hole: { x: 200, y: 200, diameter: 3, height: 3 } }), /overlap/);
});
test('float32 STL validation catches collapsed triangles', () => {
  assert.equal(closedMesh({ numProp: 3, vertProperties: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1]), triVerts: new Uint32Array([0, 1, 2]) }), false);
});
test('unsupported clients fail explicitly instead of falling back to upload', async () => {
  assert.equal(localComputeSupported(), false);
  await assert.rejects(new LocalCompute().run('analyze', {}), /Choose Server/);
});
test('client request IDs route progress and results; crashes reject all pending work', async () => {
  const previous = [globalThis.Worker, globalThis.OffscreenCanvas, globalThis.createImageBitmap];
  class FakeWorker { constructor() { FakeWorker.instance = this; } postMessage(data) { this.last = data; } terminate() { this.terminated = true; } }
  globalThis.Worker = FakeWorker; globalThis.OffscreenCanvas = class {}; globalThis.createImageBitmap = () => {};
  try {
    const client = new LocalCompute(), messages = [];
    const analyzed = client.run('analyze', {}, message => messages.push(message)), worker = FakeWorker.instance, id = worker.last.id;
    worker.onmessage({ data: { id, progress: 'Local' } }); worker.onmessage({ data: { id, result: { ok: true } } });
    assert.deepEqual(await analyzed, { ok: true }); assert.deepEqual(messages, ['Local']);
    const pending = client.run('generate', {}), rejected = assert.rejects(pending, /engine stopped/);
    worker.onerror(); await rejected; assert.equal(worker.terminated, true); assert.equal(client.pending.size, 0);
    const timedClient = new LocalCompute({ timeoutMs: 5 });
    await assert.rejects(timedClient.run('generate', {}), /generation timed out/);
    assert.equal(timedClient.worker, null); assert.equal(timedClient.pending.size, 0);
  } finally { [globalThis.Worker, globalThis.OffscreenCanvas, globalThis.createImageBitmap] = previous; }
});
