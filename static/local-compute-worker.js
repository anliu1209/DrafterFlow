import { analyzePixels } from './local-color-core.js?v=local-compute-1';
import { buildLocalColorModel } from './local-color-model.js?v=local-compute-1';
import Module from './vendor/manifold.js?v=3.5.4';

let analysis = null, analysisSequence = 0, wasmPromise = null;
const contours = new Map();
function wasm() {
  if (!wasmPromise) wasmPromise = Module({ locateFile: name => new URL(`./vendor/${name}`, import.meta.url).href }).then(api => { api.setup(); return api; }).catch(error => { wasmPromise = null; throw error; });
  return wasmPromise;
}
async function regionPng(data) {
  const canvas = new OffscreenCanvas(data.w_px, data.h_px), context = canvas.getContext('2d');
  const pixels = new Uint8ClampedArray(data.codes.length * 4);
  for (let p = 0; p < data.codes.length; p++) { const code = data.codes[p], q = p * 4; pixels[q] = code & 255; pixels[q + 1] = code >> 8 & 255; pixels[q + 2] = code >> 16 & 255; pixels[q + 3] = 255; }
  context.putImageData(new ImageData(pixels, data.w_px, data.h_px), 0, 0);
  return new FileReaderSync().readAsDataURL(await canvas.convertToBlob({ type: 'image/png' }));
}
// Serialise operations: WASM startup yields, and a newly uploaded image must
// not replace the cache beneath a pending generation.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, operation, payload } }) => {
  queue = queue.then(async () => {
    const started = performance.now(), progress = message => self.postMessage({ id, progress: message });
    try {
      if (operation === 'analyze') {
        progress('Reading artwork on this computer…');
        const bitmap = await createImageBitmap(payload.file);
        let pixels;
        try {
          if (bitmap.width * bitmap.height > 16_000_000) throw new Error('Local processing supports up to 16 megapixels. Resize the image or choose Server.');
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(bitmap, 0, 0); pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
        } finally { bitmap.close(); }
        const next = analyzePixels(pixels.data, pixels.width, pixels.height, payload.options, progress);
        const region_map_png = await regionPng(next);
        analysis = next; contours.clear(); analysisSequence++;
        const { codes, labels, ...publicData } = analysis;
        self.postMessage({ id, result: { ...publicData, region_map_png, local_analysis_id: analysisSequence, compute_ms: performance.now() - started } });
      } else if (operation === 'generate') {
        if (!analysis || payload.analysisId !== analysisSequence) throw new Error('Local analysis is out of date. Analyze the artwork again.');
        progress('Loading the local geometry engine (first generation only)…');
        const api = await wasm();
        const result = buildLocalColorModel(api, analysis, payload.options, contours, progress);
        self.postMessage({ id, result: { ...result, compute_ms: performance.now() - started } }, [result.stl]);
      } else throw new Error('Unknown local operation.');
    } catch (error) { self.postMessage({ id, error: error.message || String(error) }); }
  });
};
