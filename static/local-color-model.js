import { resolveLayers, traceMask, simplifyRing } from './local-color-core.js?v=local-compute-1';

// All Embind objects are owned by this operation, including intermediate
// booleans. Explicit disposal prevents repeated edits growing WASM memory.
export function buildLocalColorModel(api, analysis, options, contourCache = new Map(), progress = () => {}) {
  const owned = [];
  const own = value => { owned.push(value); return value; };
  const { CrossSection, Manifold } = api;
  const w = analysis.w_px, h = analysis.h_px, width = Number(options.width), base = Number(options.base), increment = Number(options.increment);
  if (![width, base, increment].every(v => Number.isFinite(v) && v > 0)) throw new Error('Width, base and increment must be positive.');
  const scale = width / w, resolved = resolveLayers(analysis, options.layers);
  const heights = [0, base];
  for (const { layer } of resolved) { const thickness = layer.height_mm == null ? increment : Number(layer.height_mm); if (!Number.isFinite(thickness) || thickness < .05 || thickness > 30) throw new Error('Each layer height must be between 0.05 and 30 mm.'); heights.push(heights.at(-1) + thickness); }
  const canonical = [0, .4, ...resolved.map((_, i) => .6 + i * .2)];
  const mapZ = (z, source, target) => {
    let i = 1; while (i < source.length - 1 && z > source[i] + 1e-6) i++;
    return target[i - 1] + (z - source[i - 1]) / (source[i] - source[i - 1]) * (target[i] - target[i - 1]);
  };
  const ringsFor = codes => {
    const key = [...codes].sort((a, b) => a - b).join(',');
    if (contourCache.has(key)) return contourCache.get(key);
    const mask = new Uint8Array(w * h); for (let p = 0; p < mask.length; p++) mask[p] = codes.has(analysis.codes[p]) ? 1 : 0;
    const rings = traceMask(mask, w, h).map(ring => simplifyRing(ring));
    // Bound cached JS contour memory; height/reorder edits hit the same keys.
    if (contourCache.size >= 32) contourCache.clear(); contourCache.set(key, rings); return rings;
  };
  const section = rings => {
    if (!rings.length) return own(CrossSection.square([0, 0]));
    const raw = own(new CrossSection(rings.map(r => r.map(([x, y]) => [(x - w / 2) * scale, (h / 2 - y) * scale])), 'EvenOdd'));
    return own(raw.simplify(scale * .45));
  };
  const area = ring => ring.reduce((n, p, i) => { const q = ring[(i + 1) % ring.length]; return n + p[0] * q[1] - q[0] * p[1]; }, 0);
  try {
    progress('Tracing local masks (cached for later height edits)…');
    const sourceSections = resolved.map(({ codes }) => own(section(ringsFor(codes)).offset(.002, 'Miter')));
    const allCodes = new Set(resolved.flatMap(r => [...r.codes]));
    // Filled silhouette beneath the colour relief supports internal islands.
    const baseSection = own(section(ringsFor(allCodes).filter(r => area(r) > 0)).offset(.004, 'Miter'));
    let hole = null, tab = null, holeHeight = .4;
    if (options.base_hole) {
      const spec = options.base_hole, diameter = Number(spec.diameter), actualHeight = Number(spec.height ?? base), x = Number(spec.x), y = Number(spec.y);
      if (![diameter, actualHeight, x, y].every(Number.isFinite) || diameter < .5 || diameter > 30 || actualHeight < .1 || actualHeight > 30) throw new Error('Invalid hole diameter, height or position.');
      hole = own(own(CrossSection.circle(diameter / 2, 128)).translate([x, y]));
      tab = own(own(CrossSection.circle(diameter / 2 + 2, 128)).translate([x, y]));
      if (own(baseSection.intersect(tab)).area() < .1) throw new Error('The hole tab must overlap the artwork. Move it closer to the edge.');
      holeHeight = mapZ(actualHeight, heights, canonical);
    }
    progress('Combining a closed printable solid locally…');
    // Nested 2D footprints remove coplanar internal walls. Small allowances
    // match the server construction and are below normal printer resolution.
    for (const allowance of [.001, .003, .005]) {
      let coverage = own(CrossSection.square([0, 0])); const tiers = [];
      for (const source of [...sourceSections].reverse()) {
        coverage = own(own(own(coverage.add(source)).offset(allowance, 'Miter')).simplify(allowance / 4)); tiers.push(coverage);
      }
      tiers.reverse();
      const backing = own(own(own(baseSection.add(tiers[0])).offset(allowance, 'Miter')).simplify(allowance / 4));
      let solid = own(backing.extrude(.4));
      const union = part => { solid = own(solid.add(part)); };
      const extrusion = (s, height, z) => own(own(s.extrude(height)).translate([0, 0, z]));
      if (tab) {
        // Cut in 2D before extrusion. A tall tab minus a 3D hole along a
        // coplanar backing wall otherwise creates float32 cap slivers.
        const baseWithHole = own(backing.subtract(hole));
        solid = own(own(own(backing.add(tab)).subtract(hole)).extrude(Math.min(.4, holeHeight)));
        if (holeHeight < .4) union(extrusion(baseWithHole, .4 - holeHeight, holeHeight));
        const outside = own(own(tab.subtract(backing)).subtract(hole));
        if (holeHeight > .4 && !outside.isEmpty()) union(extrusion(outside, holeHeight - .4, .4));
      }
      tiers.forEach((s, i) => union(extrusion(s, .2, .4 + .2 * i)));
      if (solid.status() !== 'NoError' || solid.volume() <= 0) continue;
      for (const tolerance of [.001, .0001]) {
        const mesh = own(solid.simplify(tolerance)).getMesh();
        for (let p = 2; p < mesh.vertProperties.length; p += mesh.numProp) mesh.vertProperties[p] = mapZ(Math.round(mesh.vertProperties[p] * 1e6) / 1e6, canonical, heights);
        const delivered = removeCollapsedFaces(mesh);
        if (closedMesh(delivered)) return { stl: serializeStl(delivered), final_heights: heights.slice(2), triangle_count: delivered.triVerts.length / 3 };
      }
    }
    throw new Error('Could not create a closed local model. Try small cleanup or explicitly select Server processing.');
  } finally { for (let i = owned.length - 1; i >= 0; i--) owned[i].delete(); }
}

// Validate the float32 coordinates delivered in STL, not just the WASM solid.
export function removeCollapsedFaces(mesh) {
  const triangles = [], { vertProperties: vertices, numProp } = mesh;
  const key = i => `${vertices[i * numProp]},${vertices[i * numProp + 1]},${vertices[i * numProp + 2]}`;
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const v = Array.from(mesh.triVerts.subarray(t, t + 3));
    // Boolean intersections can become zero-width faces when converted from
    // double precision to STL float32. Drop only fully collapsed edges, then
    // validate the welded delivered topology below; never hide an open seam.
    if (new Set(v.map(key)).size === 3) triangles.push(...v);
  }
  return { numProp, vertProperties: vertices, triVerts: new Uint32Array(triangles) };
}

export function closedMesh(mesh) {
  const { numProp, vertProperties: vertices, triVerts: triangles } = mesh;
  const vertexMap = new Map(), ids = [], edges = new Map(); let volume = 0;
  for (let p = 0; p < vertices.length; p += numProp) {
    const key = `${vertices[p]},${vertices[p + 1]},${vertices[p + 2]}`;
    if (!vertexMap.has(key)) vertexMap.set(key, vertexMap.size); ids.push(vertexMap.get(key));
  }
  for (let t = 0; t < triangles.length; t += 3) {
    const v = [triangles[t], triangles[t + 1], triangles[t + 2]], group = v.map(i => ids[i]);
    if (new Set(group).size !== 3) return false;
    for (let j = 0; j < 3; j++) { const a = group[j], b = group[(j + 1) % 3], key = `${Math.min(a, b)},${Math.max(a, b)}`; const e = edges.get(key) || [0, 0]; e[0]++; e[1] += a < b ? 1 : -1; edges.set(key, e); }
    const [a, b, c] = v.map(i => Array.from(vertices.subarray(i * numProp, i * numProp + 3)));
    if (![...a, ...b, ...c].every(Number.isFinite)) return false;
    const u = b.map((n, j) => n - a[j]), q = c.map((n, j) => n - a[j]);
    if (Math.hypot(u[1] * q[2] - u[2] * q[1], u[2] * q[0] - u[0] * q[2], u[0] * q[1] - u[1] * q[0]) === 0) return false;
    volume += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  const bad = [...edges.values()].filter(([count, balance]) => count !== 2 || balance !== 0);
  return triangles.length > 0 && volume > 0 && !bad.length;
}

export function serializeStl(mesh) {
  const count = mesh.triVerts.length / 3, buffer = new ArrayBuffer(84 + count * 50), view = new DataView(buffer);
  new Uint8Array(buffer, 0, 80).set(new TextEncoder().encode('DrafterFlow local WASM model'));
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const v = [0, 1, 2].map(j => { const p = mesh.triVerts[t * 3 + j] * mesh.numProp; return Array.from(mesh.vertProperties.subarray(p, p + 3)); });
    const u = v[1].map((n, j) => n - v[0][j]), q = v[2].map((n, j) => n - v[0][j]);
    const n = [u[1] * q[2] - u[2] * q[1], u[2] * q[0] - u[0] * q[2], u[0] * q[1] - u[1] * q[0]], length = Math.hypot(...n);
    let offset = 84 + t * 50; for (const value of [...n.map(x => x / length), ...v.flat()]) { view.setFloat32(offset, value, true); offset += 4; }
  }
  return buffer;
}
