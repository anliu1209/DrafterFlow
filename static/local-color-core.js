// Browser-independent colour analysis. Pixel coordinates and four-connected
// region seeds follow the server contract, so saved height groups still work.
export function rgbLab(r, g, b) {
  const linear = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  r = linear(r); g = linear(g); b = linear(b);
  const f = v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const x = f((r * .4124564 + g * .3575761 + b * .1804375) / .95047);
  const y = f(r * .2126729 + g * .7151522 + b * .072175);
  const z = f((r * .0193339 + g * .119192 + b * .9503041) / 1.08883);
  // OpenCV's encoded 8-bit Lab convention, also used by saved palettes.
  return [Math.round((116 * y - 16) * 255 / 100), Math.round(500 * (x - y) + 128), Math.round(200 * (y - z) + 128)];
}
const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearest = (a, centers) => { let best = 0, d = Infinity; centers.forEach((c, i) => { const v = distance(a, c); if (v < d) { d = v; best = i; } }); return best; };

export function connectedRegions(labels, w, h, colorCount, connectivity = 4) {
  const codes = new Uint32Array(w * h), queue = new Uint32Array(w * h), regions = [];
  for (let color = 0; color < colorCount; color++) {
    for (let first = 0; first < labels.length; first++) {
      if (labels[first] !== color || codes[first]) continue;
      const code = regions.length + 1; let head = 0, tail = 1;
      queue[0] = first; codes[first] = code;
      let xmin = first % w, xmax = xmin, ymin = Math.floor(first / w), ymax = ymin, edge = false;
      while (head < tail) {
        const p = queue[head++], x = p % w, y = Math.floor(p / w);
        xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
        edge ||= x === 0 || y === 0 || x === w - 1 || y === h - 1;
        const visit = q => { if (labels[q] === color && !codes[q]) { codes[q] = code; queue[tail++] = q; } };
        if (x) visit(p - 1); if (x < w - 1) visit(p + 1); if (y) visit(p - w); if (y < h - 1) visit(p + w);
        if (connectivity === 8) { if (y && x) visit(p - w - 1); if (y && x < w - 1) visit(p - w + 1); if (y < h - 1 && x) visit(p + w - 1); if (y < h - 1 && x < w - 1) visit(p + w + 1); }
      }
      regions.push({ code, color_id: `color-${color}`, seed: [first % w, Math.floor(first / w)], key: `color-${color}:${first % w}:${Math.floor(first / w)}`, pixel_count: tail, bounds: [xmin, ymin, xmax - xmin + 1, ymax - ymin + 1], edge });
    }
  }
  return { codes, regions };
}

export function analyzePixels(rgba, width, height, options = {}, progress = () => {}) {
  if (width * height > 16_000_000) throw new Error('Local processing supports images up to 16 megapixels. Resize the image or explicitly choose Server processing.');
  const threshold = options.alpha_threshold ?? 8, size = Number(options.palette_size ?? 5), cleanup = Number(options.cleanup_min_area ?? 0);
  if (!Number.isInteger(size) || size < 2 || size > 6 || cleanup < 0 || cleanup > 100000) throw new Error('Invalid palette size or cleanup.');
  let xmin = width, xmax = -1, ymin = height, ymax = -1, edgeVisible = 0;
  for (let p = 0; p < width * height; p++) if (rgba[p * 4 + 3] > threshold) {
    const x = p % width, y = Math.floor(p / width); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    if (!x || !y || x === width - 1 || y === height - 1) edgeVisible++;
  }
  const w = xmax - xmin + 1, h = ymax - ymin + 1;
  if (w < 2 || h < 2) throw new Error('No usable visible artwork was found.');
  const pixels = new Uint32Array(w * h), labels = new Int16Array(w * h).fill(-1), histogram = new Map();
  // Cache colour transforms by RGB instead of allocating a Lab image for every pixel.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = ((y + ymin) * width + x + xmin) * 4, p = y * w + x;
    if (rgba[q + 3] <= threshold) continue;
    const key = rgba[q] << 16 | rgba[q + 1] << 8 | rgba[q + 2]; pixels[p] = key;
    const item = histogram.get(key);
    if (item) item.count++; else {
      if (histogram.size >= 200000) throw new Error('This highly detailed image exceeds the local palette memory limit. Reduce its colours or explicitly choose Server processing.');
      histogram.set(key, { rgb: [rgba[q], rgba[q + 1], rgba[q + 2]], lab: rgbLab(rgba[q], rgba[q + 1], rgba[q + 2]), count: 1 });
    }
    labels[p] = 0;
  }
  progress('Finding the palette on this computer…');
  const peaks = [...histogram.values()].sort((a, b) => b.count - a.count), chosen = [];
  for (const item of peaks) { if (!chosen.length || chosen.every(c => distance(c.lab, item.lab) > 9)) chosen.push(item); if (chosen.length === size) break; }
  let centers = options.palette ? options.palette.map(p => p.lab || rgbLab(...p.rgb)) : chosen.map(p => [...p.lab]);
  if (!options.palette) {
    const confidentCount = peaks.reduce((n, p) => n + (distance(p.lab, centers[nearest(p.lab, centers)]) <= 9 ? p.count : 0), 0);
    const total = peaks.reduce((n, p) => n + p.count, 0);
    if (confidentCount < total / 2) for (let iteration = 0; iteration < 30; iteration++) {
      const sums = centers.map(() => [0, 0, 0, 0]);
      for (const p of peaks) { const s = sums[nearest(p.lab, centers)]; for (let j = 0; j < 3; j++) s[j] += p.lab[j] * p.count; s[3] += p.count; }
      const next = sums.map((s, i) => s[3] ? s.slice(0, 3).map(v => v / s[3]) : centers[i]);
      const change = next.reduce((n, c, i) => n + distance(c, centers[i]), 0); centers = next; if (change < .25) break;
    }
  }
  const assignments = new Map(), confidence = new Uint8Array(w * h); let confidentPixels = 0, visiblePixels = 0;
  for (const [key, p] of histogram) { const label = nearest(p.lab, centers); assignments.set(key, [label, distance(p.lab, centers[label]) <= 9]); }
  for (let p = 0; p < labels.length; p++) if (labels[p] >= 0) { const [label, confident] = assignments.get(pixels[p]); labels[p] = label; confidence[p] = confident ? 1 : 0; confidentPixels += confidence[p]; visiblePixels++; }
  // Correct uncertain anti-alias pixels only within three pixels of a flat fill.
  // Never overwrite exact tiny eye/hair highlights.
  if (confidentPixels >= visiblePixels / 2) {
    const original = labels.slice();
    for (let p = 0; p < labels.length; p++) if (labels[p] >= 0 && !confidence[p]) {
      const x = p % w, y = Math.floor(p / w); let best = 10, color = labels[p];
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const d = dx * dx + dy * dy; if (d > 9 || d >= best || x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
        const q = p + dy * w + dx; if (confidence[q]) { best = d; color = original[q]; }
      }
      labels[p] = color;
    }
  }
  progress('Identifying connected regions locally…');
  let background_id = null, background_pixel_count = 0;
  if (edgeVisible / Math.max(1, 2 * width + 2 * height - 4) >= .9) {
    const edges = centers.map(() => 0);
    for (let p = 0; p < labels.length; p++) if (labels[p] >= 0 && (!(p % w) || p % w === w - 1 || p < w || p >= w * (h - 1))) edges[labels[p]]++;
    const candidate = edges.indexOf(Math.max(...edges));
    if (edges[candidate] / (2 * w + 2 * h - 4) >= .35) {
      background_id = options.palette?.[candidate]?.id || `color-${candidate}`;
      const connected = connectedRegions(labels, w, h, centers.length);
      const outside = new Set(connected.regions.filter(r => r.color_id === `color-${candidate}` && r.edge).map(r => r.code));
      for (let p = 0; p < labels.length; p++) if (outside.has(connected.codes[p])) { background_pixel_count++; if (options.remove_background) labels[p] = -1; }
    }
  }
  if (cleanup > 0) {
    const c = connectedRegions(labels, w, h, centers.length, 8), small = new Set(c.regions.filter(r => r.pixel_count < cleanup).map(r => r.code));
    for (let p = 0; p < labels.length; p++) if (small.has(c.codes[p])) labels[p] = -1;
  }
  const { codes, regions } = connectedRegions(labels, w, h, centers.length);
  const palette = centers.map((lab, i) => {
    const rgb = options.palette?.[i]?.rgb || peaks.reduce((best, p) => distance(p.lab, lab) < distance(best.lab, lab) ? p : best, peaks[0]).rgb;
    const id = options.palette?.[i]?.id || `color-${i}`;
    let count = 0, edge = 0; for (let p = 0; p < labels.length; p++) if (labels[p] === i) { count++; if (!(p % w) || p % w === w - 1 || p < w || p >= w * (h - 1)) edge++; }
    for (const r of regions) if (r.color_id === `color-${i}`) { r.color_id = id; r.key = `${id}:${r.seed.join(':')}`; }
    return { id, rgb, lab, hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''), pixel_count: count, edge_pixel_count: edge };
  });
  if (!palette.some(p => p.pixel_count)) throw new Error('Background removal or cleanup removed all artwork.');
  return { ok: true, w_px: w, h_px: h, pixel_size_mm: Number(options.width || 80) / w, source_color_count: Math.min(999, histogram.size), palette, regions, codes, labels, background_id, background_pixel_count, background_removed: !!options.remove_background && background_id !== null };
}

export function resolveLayers(analysis, layers) {
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > 24) throw new Error('Choose 1–24 layers.');
  const occupied = new Set(), seen = new Set(), result = [];
  for (const layer of layers) {
    if (!layer.id || seen.has(layer.id)) throw new Error('Layer identifiers must be unique.'); seen.add(layer.id);
    const source = layer.source_color_id || layer.id;
    if (!analysis.palette.some(p => p.id === source)) throw new Error('Unknown source colour. Analyze again.');
    if (layer.ignored) continue;
    const lookup = seed => {
      if (!Array.isArray(seed) || seed.length !== 2 || !seed.every(Number.isInteger)) throw new Error('Invalid region seed.');
      const [x, y] = seed; if (x < 0 || y < 0 || x >= analysis.w_px || y >= analysis.h_px) return 0;
      const code = analysis.codes[y * analysis.w_px + x]; return analysis.regions[code - 1]?.color_id === source ? code : 0;
    };
    let codes;
    if (layer.region_seeds == null) codes = new Set(analysis.regions.filter(r => r.color_id === source).map(r => r.code));
    else { codes = new Set(layer.region_seeds.map(s => { const code = lookup(s); if (!code) throw new Error('A selected region changed. Analyze and select again.'); return code; })); }
    for (const s of layer.excluded_region_seeds || []) codes.delete(lookup(s));
    if (!codes.size) continue;
    for (const code of codes) { if (occupied.has(code)) throw new Error('The same region belongs to two layers. Split it first.'); occupied.add(code); }
    result.push({ layer, codes });
  }
  if (!result.length) throw new Error('Enable at least one non-empty layer.');
  return result;
}

// Trace exact pixel-cell boundaries, including holes; right turns keep
// diagonal contacts separate instead of making self-intersecting figure-eights.
export function traceMask(mask, w, h) {
  const edges = new Map(), stride = w + 1;
  const add = (a, b, dir) => { if (!edges.has(a)) edges.set(a, []); edges.get(a).push({ b, dir }); };
  for (let p = 0; p < mask.length; p++) if (mask[p]) {
    const x = p % w, y = Math.floor(p / w), a = y * stride + x;
    if (!y || !mask[p - w]) add(a, a + 1, 0);
    if (x === w - 1 || !mask[p + 1]) add(a + 1, a + stride + 1, 1);
    if (y === h - 1 || !mask[p + w]) add(a + stride + 1, a + stride, 2);
    if (!x || !mask[p - 1]) add(a + stride, a, 3);
  }
  const rings = [];
  while (edges.size) {
    const start = edges.keys().next().value, ring = []; let a = start, incoming = -1;
    do {
      ring.push([a % stride, Math.floor(a / stride)]);
      const options = edges.get(a); if (!options?.length) throw new Error('Open pixel contour.');
      let index = 0;
      if (incoming >= 0 && options.length > 1) index = options.findIndex(e => e.dir === (incoming + 1) % 4);
      if (index < 0) index = 0;
      const edge = options.splice(index, 1)[0]; if (!options.length) edges.delete(a);
      a = edge.b; incoming = edge.dir;
    } while (a !== start);
    // Drop collinear samples without losing small highlights.
    rings.push(ring.filter((p, i) => { const before = ring[(i + ring.length - 1) % ring.length], after = ring[(i + 1) % ring.length]; return (p[0] - before[0]) * (after[1] - p[1]) !== (p[1] - before[1]) * (after[0] - p[0]); }));
  }
  return rings;
}

// Bounded sub-pixel contour simplification: removes the pixel staircase on
// long curves without deleting one-pixel highlights or thin closed regions.
export function simplifyRing(ring, epsilon = .6) {
  if (ring.length < 12) return ring;
  const segment = points => {
    const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(), start = points[a], end = points[b], dx = end[0] - start[0], dy = end[1] - start[1], length = dx * dx + dy * dy;
      let furthest = -1, max = epsilon * epsilon;
      for (let i = a + 1; i < b; i++) {
        const p = points[i], t = length ? Math.max(0, Math.min(1, ((p[0] - start[0]) * dx + (p[1] - start[1]) * dy) / length)) : 0;
        const d = (p[0] - start[0] - t * dx) ** 2 + (p[1] - start[1] - t * dy) ** 2;
        if (d > max) { max = d; furthest = i; }
      }
      if (furthest >= 0) { keep[furthest] = 1; stack.push([a, furthest], [furthest, b]); }
    }
    return points.filter((_, i) => keep[i]);
  };
  let opposite = 1, max = 0;
  ring.forEach((p, i) => { const d = (p[0] - ring[0][0]) ** 2 + (p[1] - ring[0][1]) ** 2; if (d > max) { opposite = i; max = d; } });
  const result = [...segment(ring.slice(0, opposite + 1)).slice(0, -1), ...segment([...ring.slice(opposite), ring[0]]).slice(0, -1)];
  return result.length >= 3 ? result : ring;
}
