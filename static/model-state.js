// Geometry revision tracking is independent from names, visibility and preview tabs.
// Keeping the previous model makes iterative editing useful without serving stale STL.
export class ModelLifecycle {
  constructor() { this.revision = 0; this.currentRevision = -1; this.hasModel = false; this.pending = null; }
  invalidate(reset = false) {
    this.revision++;
    if (reset) { this.hasModel = false; this.currentRevision = -1; }
  }
  begin() { this.pending = this.revision; return this.pending; }
  accepts(token) { return token === this.revision && token === this.pending; }
  complete(token) {
    if (!this.accepts(token)) return false;
    this.hasModel = true; this.currentRevision = token; this.pending = null; return true;
  }
  finish(token) { if (this.pending === token) this.pending = null; }
  get dirty() { return this.hasModel && this.currentRevision !== this.revision; }
  get current() { return this.hasModel && !this.dirty; }
  get generating() { return this.pending !== null; }
}
