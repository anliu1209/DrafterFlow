// No server fallback here: choosing Server is an explicit user action.
export const localComputeSupported = () => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function' && typeof WebAssembly !== 'undefined';
export class LocalCompute {
  constructor({ timeoutMs = 120000 } = {}) { this.worker = null; this.sequence = 0; this.pending = new Map(); this.timeoutMs = timeoutMs; }
  run(operation, payload, progress = () => {}) {
    if (!localComputeSupported()) return Promise.reject(new Error('This browser does not support local computation. Choose Server in Advanced or use a current desktop browser.'));
    if (!this.worker) {
      const url = new URL('./local-compute-worker.js', import.meta.url); url.search = import.meta.url.search;
      this.worker = new Worker(url, { type: 'module', name: 'DrafterFlow local geometry' });
      this.worker.onmessage = ({ data }) => {
        const request = this.pending.get(data.id); if (!request) return;
        if (data.progress) { request.progress(data.progress); return; }
        clearTimeout(request.timer);
        this.pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
      };
      this.worker.onerror = () => this.reset('The local engine stopped. Analyze again, or explicitly select Server in Advanced.');
      this.worker.onmessageerror = () => this.reset('The browser could not read a local computation result. Analyze again.');
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reset(`Local ${operation === 'generate' ? 'generation' : 'analysis'} timed out. Click Analyze Image and retry, or explicitly choose Server in Advanced.`), this.timeoutMs);
      this.pending.set(id, { resolve, reject, progress, timer });
      try { this.worker.postMessage({ id, operation, payload }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reset(message = 'Local computation was cancelled.') {
    this.worker?.terminate(); this.worker = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); } this.pending.clear();
  }
}
