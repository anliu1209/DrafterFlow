import * as THREE from 'three';
import { STLLoader } from 'three/addons/STLLoader.js';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const $ = (sel) => document.querySelector(sel);
const num = (el) => { const v = parseFloat(el.value); return isNaN(v) ? 0 : v; };
const int = (el) => { const v = parseInt(el.value, 10); return isNaN(v) ? 0 : v; };

// ---------- state ----------
let sourceFile = null;      // File / Blob currently in use
let sourceUrl = null;       // object URL for the "原图" view
let sourceName = '';
let analysis = null;        // result of /api/analyze
let layerState = { base: true, relief: true };  // preview-only layer visibility
let holes = [];             // [{id, x, y, outer, inner, valid}] in mm
let activeTool = 'select';  // select | hole | eraser | draw (later)
let selectedHoleId = null;
let holeSeq = 1;
let snapEnabled = true;     // magnetic snapping
let undoStack = [], redoStack = [];
let basePoly = [];          // base silhouette rings, image px (from analysis.base_poly)
let stlBlob = null;
let holeCenter = null;
let committedSourceName = null;  // the source that produced the current STL
let pendingSource = null;        // {file, name} awaiting "switch image?" confirm

// ---------- three.js ----------
let renderer, scene, camera, controls, modelGroup, grid;
let baseMat = null, topMat = null, baseMesh = null, topMesh = null;

function initThree() {
  const canvas = $('#threeCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Crisper, less "airbrush" lighting: low ambient, strong key, weak fill.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2830, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(5, 7, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(-5, 2, -4);
  scene.add(fill);

  grid = new THREE.GridHelper(8, 20, 0x3c3a49, 0x26252e);
  grid.visible = false;
  scene.add(grid);

  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  resize();
  window.addEventListener('resize', resize);
  animate();
}

function resize() {
  const vp = $('#viewport');
  const w = vp.clientWidth, h = vp.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function fitCamera() {
  const sphere = new THREE.Box3().setFromObject(modelGroup)
    .getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius * 2.7;
  // Low, slightly side-on angle so the thin relief layer reads clearly against the base.
  camera.position.set(dist * 1.2, dist * 0.55, dist * 0.9);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
}

function makePartGeometry(flatArray) {
  // Keep facets flat so the 90° edges between the two layers stay crisp. Smoothing
  // normals here rounded the relief into a blob; curved-edge smoothness belongs to
  // geometry-level contour smoothing (see the TODO in vectorize.py), not the render.
  const g = new THREE.BufferGeometry();
  if (!flatArray.length) return g;
  g.setAttribute('position', new THREE.Float32BufferAttribute(flatArray, 3));
  return g;
}

function loadStl(blob, baseThickness) {
  const url = URL.createObjectURL(blob);
  const loader = new STLLoader();
  loader.load(url, (geometry) => {
    URL.revokeObjectURL(url);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const s = 3 / (Math.max(size.x, size.y, size.z) || 1);
    const baseTop = box.min.z + baseThickness;
    // STL stores z as float32, which rounds the base-top plane (e.g. 1.2) up to
    // ~1.20000005 — just above double-precision baseTop (1.19999999…). Without a
    // tolerance the whole base top face flips into the relief mesh and swallows it.
    // A 1 µm epsilon absorbs that quantization while leaving real relief triangles
    // (centroids ≥ a layer-height above the swap line) untouched.
    const eps = 1e-3;

    // Split triangles into the two layers at the swap line. Each layer becomes its
    // own solid-colour mesh, so the base/colour boundary stays crisp (no gradient),
    // while smooth normals keep the curves free of flat-shading "jaggies".
    const pos = geometry.getAttribute('position');
    const base = [], top = [];
    for (let i = 0; i < pos.count; i += 3) {
      const zc = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const arr = zc <= baseTop + eps ? base : top;
      for (let k = 0; k < 3; k++) {
        arr.push(
          (pos.getX(i + k) - center.x) * s,
          (pos.getY(i + k) - center.y) * s,
          (pos.getZ(i + k) - center.z) * s,
        );
      }
    }

    while (modelGroup.children.length) modelGroup.remove(modelGroup.children[0]);
    baseMesh = null; topMesh = null;
    if (base.length) {
      baseMat = new THREE.MeshStandardMaterial({ color: baseHex(), roughness: 0.5, metalness: 0.06, flatShading: true });
      baseMesh = new THREE.Mesh(makePartGeometry(base), baseMat);
      modelGroup.add(baseMesh);
    }
    if (top.length) {
      topMat = new THREE.MeshStandardMaterial({ color: colorHex(), roughness: 0.5, metalness: 0.06, flatShading: true });
      topMesh = new THREE.Mesh(makePartGeometry(top), topMat);
      modelGroup.add(topMesh);
    }
    updateLayerVisibility();

    grid.visible = true;
    grid.position.y = (box.min.z - center.z) * s - 0.05;
    fitCamera();

    $('#vpEmpty').hidden = true;
    $('#resetView').hidden = false;
    $('#vpInfo').hidden = false;
  }, undefined, (err) => {
    setStatus(t('stl_failed') + (err && err.message ? err.message : 'unknown error'), 'err');
  });
}

// ---------- colours ----------
function baseHex() { return $('#baseColor').value; }
function colorHex() { return $('#colorColor').value; }
function onColorChange() {
  if (baseMat) baseMat.color.set(baseHex());
  if (topMat) topMat.color.set(colorHex());
  const bs = document.querySelector('.swatch-base'), rs = document.querySelector('.swatch-relief');
  if (bs) bs.style.background = baseHex();
  if (rs) rs.style.background = colorHex();
  renderGauge();
  scheduleAnalyze();
}

// ---------- 2D editor canvas + tools + multi-hole ----------
const VIEW_SRC = { combined: 'combined_png', base: 'base_png', color: 'color_png' };
let canvas, ictx;
let view = { zoom: 1, ox: 0, oy: 0 };   // image-px -> canvas-px: c = img*zoom + o
let dragState = null;                    // {type:'pan'|'move'|'add', ...}
let editorImg = new Image();

function updateLayerVisibility() {
  layerState.base = $('#layerBaseEye').classList.contains('is-on');
  layerState.relief = $('#layerReliefEye').classList.contains('is-on');
  if (baseMesh) baseMesh.visible = layerState.base;
  if (topMesh) topMesh.visible = layerState.relief;
}

function refreshLayerPanel() {
  if (!analysis) return;
  $('#layerBaseThumb').src = analysis.base_png; $('#layerBaseThumb').hidden = false;
  $('#layerReliefThumb').src = analysis.color_png; $('#layerReliefThumb').hidden = false;
}

function onLayerToggle() {
  this.classList.toggle('is-on');
  this.setAttribute('aria-pressed', String(this.classList.contains('is-on')));
  updateLayerVisibility();
  loadLayerPreview();
}

// px <-> mm (mirrors model_builder._scale_and_center)
function pxScaleMm() {
  return num($('#width')) / Math.max(analysis.w_px, analysis.h_px);
}
function pxToMm(nx, ny) {
  const sc = pxScaleMm();
  return { x: sc * (nx - analysis.w_px / 2), y: sc * (analysis.h_px / 2 - ny) };
}
function mmToPx(mx, my) {
  const sc = pxScaleMm();
  return { x: mx / sc + analysis.w_px / 2, y: analysis.h_px / 2 - my / sc };
}
// Magnetic snapping: centre (0,0) or the bbox edges (hang-tab straddle).
function snapMm(c) {
  if (!snapEnabled) return c;
  const sc = pxScaleMm();
  const ex = (analysis.w_px / 2) * sc;
  const ey = (analysis.h_px / 2) * sc;
  const tolC = 2, tolE = 4;
  let x = c.x, y = c.y;
  if (Math.abs(x) < tolC) x = 0;
  if (Math.abs(y) < tolC) y = 0;
  if (Math.abs(x - ex) < tolE) x = ex;
  else if (Math.abs(x + ex) < tolE) x = -ex;
  if (Math.abs(y - ey) < tolE) y = ey;
  else if (Math.abs(y + ey) < tolE) y = -ey;
  return { x, y };
}

// validity: outer circle intersects the base silhouette (px rings).
function holeValid(h) {
  const sc = pxScaleMm();
  const p = mmToPx(h.x, h.y);
  const outerPx = (h.outer || h.inner) / sc;
  if (pointInAnyRing(p.x, p.y)) return true;
  for (const ring of basePoly) if (distToRing(p.x, p.y, ring) <= outerPx) return true;
  return false;
}
function pointInAnyRing(px, py) {
  return basePoly.some(ring => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}
function distToRing(px, py, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    best = Math.min(best, Math.hypot(px - qx, py - qy));
  }
  return best;
}

function toCanvas(ix, iy) { return { x: view.ox + ix * view.zoom, y: view.oy + iy * view.zoom }; }
function toImage(cx, cy) { return { x: (cx - view.ox) / view.zoom, y: (cy - view.oy) / view.zoom }; }

function renderCanvas() {
  if (!ictx || !analysis) return;
  const W = canvas.width, H = canvas.height;
  ictx.clearRect(0, 0, W, H);
  const c0 = toCanvas(0, 0), c1 = toCanvas(analysis.w_px, analysis.h_px);
  if (editorImg.src && editorImg.naturalWidth)
    ictx.drawImage(editorImg, c0.x, c0.y, c1.x - c0.x, c1.y - c0.y);
  for (const h of holes) drawHole(h);
  const sel = holes.find(h => h.id === selectedHoleId);
  if (sel) drawSelection(sel);
  drawDimensions();
}

function drawDimensions() {
  if (!analysis) return;
  const H = canvas.height;
  const scale = pxScaleMm();
  const widthMm = analysis.w_px * scale;
  const heightMm = analysis.h_px * scale;
  const depthMm = num($('#base')) + num($('#color'));
  ictx.save();
  const blue = 'rgba(37,99,235,0.88)';
  ictx.fillStyle = blue; ictx.strokeStyle = blue; ictx.lineWidth = 1.4;
  ictx.font = '12px ui-monospace, monospace';
  // scale ruler (bottom-left) + a plain size readout beside it
  const tickMm = [2, 5, 10, 20, 50].find(m => (m / scale) * view.zoom > 20) || 50;
  const rulerPx = (tickMm / scale) * view.zoom;
  const rx = 14, ry = H - 16;
  ictx.textAlign = 'left'; ictx.textBaseline = 'bottom';
  ictx.fillText(`${widthMm.toFixed(2)} × ${heightMm.toFixed(2)} × ${depthMm.toFixed(2)} mm`, rx, ry - 18);
  ictx.beginPath(); ictx.moveTo(rx, ry); ictx.lineTo(rx + rulerPx, ry); ictx.stroke();
  ictx.beginPath(); ictx.moveTo(rx, ry - 5); ictx.lineTo(rx, ry + 5); ictx.moveTo(rx + rulerPx, ry - 5); ictx.lineTo(rx + rulerPx, ry + 5); ictx.stroke();
  ictx.textBaseline = 'top';
  ictx.fillText(`${tickMm} mm`, rx + rulerPx + 6, ry - 5);
  ictx.restore();
}

function drawHole(h) {
  const sc = pxScaleMm();
  const c0 = toCanvas(mmToPx(h.x, h.y).x, mmToPx(h.x, h.y).y);
  const rOut = ((h.outer || h.inner) / sc) * view.zoom;
  const rIn = (h.inner / sc) * view.zoom;
  const col = h.valid ? '#23a55a' : '#e03e3e';
  ictx.strokeStyle = col; ictx.lineWidth = 1.6;
  ictx.fillStyle = h.valid ? 'rgba(35,165,90,0.10)' : 'rgba(224,62,62,0.12)';
  ictx.beginPath(); ictx.arc(c0.x, c0.y, rOut, 0, Math.PI * 2); ictx.fill();
  ictx.setLineDash([4, 3]); ictx.beginPath(); ictx.arc(c0.x, c0.y, rOut, 0, Math.PI * 2); ictx.stroke(); ictx.setLineDash([]);
  ictx.lineWidth = 1.8; ictx.beginPath(); ictx.arc(c0.x, c0.y, rIn, 0, Math.PI * 2); ictx.stroke();
}

function drawSelection(h) {
  const sc = pxScaleMm();
  const c0 = toCanvas(mmToPx(h.x, h.y).x, mmToPx(h.x, h.y).y);
  const rOut = ((h.outer || h.inner) / sc) * view.zoom;
  const pad = 6;
  ictx.strokeStyle = '#3d7be0'; ictx.lineWidth = 1.5; ictx.setLineDash([5, 4]);
  ictx.strokeRect(c0.x - rOut - pad, c0.y - rOut - pad, (rOut + pad) * 2, (rOut + pad) * 2);
  ictx.setLineDash([]);
  ictx.fillStyle = '#3d7be0';
  ictx.beginPath(); ictx.arc(c0.x, c0.y, 2.5, 0, Math.PI * 2); ictx.fill();
}

function loadLayerPreview() {
  if (!analysis) { editorImg.src = ''; return; }
  const src = layerState.base && layerState.relief ? analysis.combined_png
    : layerState.base ? analysis.base_png
    : layerState.relief ? analysis.color_png : null;
  if (!src) { editorImg.src = ''; renderCanvas(); return; }
  editorImg.onload = () => renderCanvas();
  editorImg.src = src;
}

function fitCanvas() {
  if (!analysis) return;
  const wrap = $('#canvasWrap');
  const W = Math.max(1, wrap.clientWidth), H = Math.max(1, wrap.clientHeight);
  canvas.width = W; canvas.height = H;
  const s = Math.min(W / analysis.w_px, H / analysis.h_px) * 0.93;
  view.zoom = s;
  view.ox = (W - analysis.w_px * s) / 2;
  view.oy = (H - analysis.h_px * s) / 2;
  renderCanvas();
}

function recompute() {
  holes.forEach(h => { h.valid = holeValid(h); });
  renderHoleList();
  renderCanvas();
  updateHoleMessage();
  updateHolePos();
}

function updateHolePos() {
  const el = $('#holePos');
  if (!el) return;
  const sel = holes.find(h => h.id === selectedHoleId);
  el.textContent = sel ? `X ${sel.x.toFixed(1)} · Y ${sel.y.toFixed(1)}` : t('hole_pos_none');
  el.classList.toggle('muted', !sel);
  // Magnetic toggle appears only when a ring is selected; the Outer field edits it.
  const sm = $('#snapToggle');
  if (sm) {
    sm.hidden = !sel;
    if (sel) {
      sm.classList.toggle('is-active', snapEnabled);
      sm.setAttribute('aria-pressed', String(snapEnabled));
    }
  }
  const ho = $('#newHoleOuter');
  if (ho && sel && document.activeElement !== ho) ho.value = sel.outer != null ? sel.outer : '';
}

function updateHoleMessage() {
  const msg = $('#holeMessage');
  const invalid = holes.filter(h => !h.valid);
  if (analysis && invalid.length) {
    msg.textContent = t('hole_invalid');   // "cannot print, choose a suitable position"
    msg.classList.add('bad'); msg.hidden = false;
  } else { msg.hidden = true; msg.classList.remove('bad'); }
}

function canvasPoint(evt) {
  const r = canvas.getBoundingClientRect();
  return { x: evt.clientX - r.x, y: evt.clientY - r.y };
}
function hitHole(cx, cy) {
  const ip = toImage(cx, cy); const mm = pxToMm(ip.x, ip.y);
  const sc = pxScaleMm();
  for (let i = holes.length - 1; i >= 0; i--) {
    const h = holes[i];
    const r = ((h.outer || h.inner) / sc) * view.zoom;
    const c0 = toCanvas(mmToPx(h.x, h.y).x, mmToPx(h.x, h.y).y);
    if (Math.hypot(cx - c0.x, cy - c0.y) <= r) return h;
  }
  return null;
}

function onCanvasPointerDown(evt) {
  if (!analysis) return;
  const p = canvasPoint(evt);
  // middle-drag always pans
  if (evt.button === 1) { evt.preventDefault(); dragState = { type: 'pan', sx: p.x, sy: p.y, ox: view.ox, oy: view.oy }; return; }
  if (activeTool === 'hole') {
    const existing = hitHole(p.x, p.y);
    if (existing) { selectedHoleId = existing.id; recompute(); return; }  // select an existing ring, don't stack/move
    snapshotHoles();
    const c = snapMm(pxToMm(toImage(p.x, p.y).x, toImage(p.x, p.y).y));
    const inner = num($('#hole')) / 2;
    const outer = $('#newHoleOuter').value ? num($('#newHoleOuter')) : inner + 2;
    const hole = { id: holeSeq++, x: c.x, y: c.y, outer, inner, valid: true };
    holes.push(hole);
    selectedHoleId = hole.id;
    recompute();
  } else if (activeTool === 'eraser') {
    const h = hitHole(p.x, p.y);
    if (h) { snapshotHoles(); holes = holes.filter(x => x.id !== h.id); if (selectedHoleId === h.id) selectedHoleId = null; recompute(); }
  } else {
    const h = hitHole(p.x, p.y);
    if (h) { snapshotHoles(); selectedHoleId = h.id; dragState = { type: 'move', hole: h }; }
    else { selectedHoleId = null; dragState = { type: 'pan', sx: p.x, sy: p.y, ox: view.ox, oy: view.oy }; }
    recompute();
  }
}
function onCanvasPointerMove(evt) {
  if (!dragState) return;
  const p = canvasPoint(evt);
  if (dragState.type === 'pan') {
    view.ox = dragState.ox + (p.x - dragState.sx);
    view.oy = dragState.oy + (p.y - dragState.sy);
    renderCanvas();
  } else if (dragState.type === 'move') {
    const c = snapMm(pxToMm(toImage(p.x, p.y).x, toImage(p.x, p.y).y));
    dragState.hole.x = c.x; dragState.hole.y = c.y;
    recompute();
  }
}
function onCanvasPointerUp() {
  if (dragState && dragState.type === 'add') { /** no-op */ }
  dragState = null;
}
function onCanvasWheel(evt) {
  if (!analysis) return;
  evt.preventDefault();
  const p = canvasPoint(evt);
  const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
  const ns = Math.max(0.1, Math.min(12, view.zoom * factor));
  view.ox = p.x - (p.x - view.ox) * (ns / view.zoom);
  view.oy = p.y - (p.y - view.oy) * (ns / view.zoom);
  view.zoom = ns;
  renderCanvas();
}

function setTool(name) {
  activeTool = name;
  ['select', 'hole', 'eraser', 'draw'].forEach(n => {
    const b = $('#tool' + n.charAt(0).toUpperCase() + n.slice(1));
    if (b) { b.classList.toggle('is-active', n === name); b.setAttribute('aria-pressed', String(n === name)); }
  });
  canvas.classList.toggle('is-placement', activeTool === 'hole');
}

function deleteSelectedHole() {
  if (selectedHoleId == null) return;
  snapshotHoles();
  holes = holes.filter(x => x.id !== selectedHoleId);
  selectedHoleId = null;
  recompute();
}

function renderHoleList() {
  const list = $('#holeList');
  if (!list) return;
  list.innerHTML = '';
  holes.forEach(h => {
    const row = document.createElement('div');
    row.className = 'hole-item' + (h.id === selectedHoleId ? ' selected' : '');
    row.innerHTML = `<span class="hole-dot ${h.valid ? 'ok' : 'bad'}" title="${h.valid ? '' : t('hole_invalid')}"></span>`
      + `<label>X<input type="number" class="hx" step="0.5" value="${h.x.toFixed(2)}"></label>`
      + `<label>Y<input type="number" class="hy" step="0.5" value="${h.y.toFixed(2)}"></label>`
      + `<input type="number" class="houter" step="0.5" value="${h.outer != null ? h.outer.toFixed(2) : ''}" placeholder="${t('ring_outer')}">`
      + `<button class="hd" type="button" title="Delete">×</button>`;
    row.addEventListener('click', (evt) => { if (evt.target.closest('.hd')) return; selectedHoleId = h.id; renderHoleList(); renderCanvas(); });
    row.querySelector('.hx').addEventListener('input', (evt) => { snapshotHoles(); h.x = num(evt.target); recompute(); });
    row.querySelector('.hy').addEventListener('input', (evt) => { snapshotHoles(); h.y = num(evt.target); recompute(); });
    row.querySelector('.houter').addEventListener('input', (evt) => { snapshotHoles(); h.outer = evt.target.value === '' ? null : num(evt.target); recompute(); });
    row.querySelector('.hd').addEventListener('click', () => { snapshotHoles(); holes = holes.filter(x => x.id !== h.id); if (selectedHoleId === h.id) selectedHoleId = null; recompute(); });
    list.appendChild(row);
  });
}

function snapshotHoles() {
  undoStack.push(holes.map(h => ({ ...h })));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}
function undoHoles() {
  if (!undoStack.length) return;
  redoStack.push(holes.map(h => ({ ...h })));
  holes = undoStack.pop();
  if (selectedHoleId != null && !holes.some(h => h.id === selectedHoleId)) selectedHoleId = null;
  recompute();
}
function redoHoles() {
  if (!redoStack.length) return;
  undoStack.push(holes.map(h => ({ ...h })));
  holes = redoStack.pop();
  recompute();
}
function clearHoles() { snapshotHoles(); holes = []; selectedHoleId = null; recompute(); }

function setupCanvas() {
  canvas = $('#editorCanvas');
  ictx = canvas.getContext('2d');
  canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('pointermove', onCanvasPointerMove);
  window.addEventListener('pointerup', onCanvasPointerUp);
}

function zoomBy(f) {
  if (!analysis) return;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const ns = Math.max(0.1, Math.min(12, view.zoom * f));
  view.ox = cx - (cx - view.ox) * (ns / view.zoom);
  view.oy = cy - (cy - view.oy) * (ns / view.zoom);
  view.zoom = ns;
  renderCanvas();
}

// ---------- cross-section gauge ----------
function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function renderGauge() {
  const gauge = $('#gauge');
  const base = num($('#base'));
  const color = num($('#color'));
  const hole = num($('#hole'));
  const total = base + color;
  const H = gauge.clientHeight || 46;
  const pad = 4;
  const usable = H - pad * 2;
  const scale = total > 0 ? usable / total : 0;
  const baseH = Math.max(base * scale, 1);
  const colorH = Math.max(color * scale, 1);

  const holeW = Math.min(Math.max(hole * 2.6, 8), 32);
  const holeLeft = 16;

  const baseBar = el('div', 'gauge-bar');
  baseBar.style.cssText = `left:0;right:0;bottom:${pad}px;height:${baseH}px;background:${baseHex()};`;
  const colorBar = el('div', 'gauge-bar');
  colorBar.style.cssText = `left:0;right:0;bottom:${pad + baseH}px;height:${colorH}px;background:${colorHex()};`;

  const swap = el('div', 'gauge-swap');
  swap.style.top = `${H - (pad + baseH)}px`;

  const holeEl = el('div', 'gauge-hole');
  holeEl.style.cssText = `left:${holeLeft}px;width:${holeW}px;top:${pad}px;bottom:${pad}px;`;

  const holeLabel = el('div', 'gauge-label');
  holeLabel.textContent = `Ø${hole.toFixed(1)}`;
  holeLabel.style.cssText = `left:${holeLeft}px;top:2px;transform:none;`;

  const swapLabel = el('div', 'gauge-label');
  swapLabel.textContent = `${base.toFixed(1)}`;
  swapLabel.style.cssText = `left:${holeLeft + holeW + 8}px;top:${H - (pad + baseH) - 8}px;`;

  const totalLabel = el('div', 'gauge-label gauge-label--total');
  totalLabel.textContent = `${t('gauge_total')} ${total.toFixed(1)} mm`;

  gauge.innerHTML = '';
  gauge.append(baseBar, colorBar, swap, holeEl, holeLabel, swapLabel, totalLabel);

  $('#gaugeReadout').innerHTML =
    `<span>${t('gauge_base')} <b>${base.toFixed(1)}</b> mm · ${t('gauge_relief')} <b>${color.toFixed(1)}</b> mm</span>` +
    `<span class="swap-note">${t('gauge_swap')}${base.toFixed(1)} mm</span>`;
}

// ---------- status ----------
function setStatus(msg, kind) {
  const s = $('#status');
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- theme ----------
const THEME_KEY = 'sketchforge_theme';
function initTheme() {
  const root = document.documentElement;
  root.dataset.theme = localStorage.getItem(THEME_KEY) || 'light';
  const btn = $('#themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
    });
  }
}

// ---------- i18n ----------
const I18N = {
  en: {
    nav_how: 'How it works', nav_use: 'What you can make', nav_gallery: 'Gallery', nav_about: 'About',
    cta_create: 'Create a 3D model', cta_how: 'How it works',
    hero_eyebrow: '2D drawing → 3D relief → physical object',
    hero_title: 'Turn your drawings into physical objects.',
    hero_sub: 'SketchForge transforms 2D drawings into manufacturable 3D models — no 3D modeling experience required.',
    hv_drawing: 'Your drawing', hv_layers: 'Detected layers', hv_printable: 'Printable relief',
    hv_base: '1.2 mm base', hv_relief: '0.6 mm relief', hv_note: 'One STL, one filament swap.',
    forge_title: 'Create your model', forge_sub: 'Upload a drawing with a transparent background and dark line work.', forge_note: 'No 3D modeling experience required.',
    card_drawing: 'Drawing', card_dims: 'Dimensions', card_colors: 'Colors', card_section: 'Cross-section',
    drop_main: 'Drop your drawing here, or ', drop_choose: 'choose an image', drop_hint: 'PNG · transparent background · dark line art',
    examples_label: 'Examples', example_txt: 'Frame & text', example_heart: 'Heart', example_qban: 'Line art',
    dim_width: 'Model width', dim_base: 'Base thickness', dim_relief: 'Relief thickness', dim_hole: 'Keychain hole',
    chip_light: 'light', chip_dark: 'dark',
    adv_summary: 'Advanced · thresholds & hole position',
    adv_dark: 'Dark threshold', adv_dark_hint: 'pixels darker than this become relief',
    adv_alpha: 'Alpha threshold', adv_alpha_hint: 'pixels more opaque than this become the base',
    adv_hole: 'Hole X / Y', adv_hole_hint: 'leave blank to auto-place', hole_x_ph: 'X mm', hole_y_ph: 'Y mm',
    color_base: 'Base', color_relief: 'Relief', color_note: 'Preview colors — the real print color comes from your filament.',
    btn_generate: 'Generate STL', btn_download: 'Download STL',
    seg_original: 'Original', seg_layers: 'Layers', seg_base: 'Base', seg_relief: 'Relief',
    orig_label: 'Original', orig_hint: 'reference', orig_toggle: '−',
    tool_hole: 'Hole',
    tool_select: 'Select', tool_eraser: 'Eraser', tool_draw: 'Draw (soon)',
    zoom_fit: 'Fit',
    snap: 'Magnetic', hole_pos_none: 'No hole selected', canvas_hint: 'scroll to zoom · drag to pan',
    card_holes: 'Holes', new_hole_outer: 'New ring outer', hole_invalid: '⚠ cannot print — pick a position on the base',
    adv_ring: 'Hang-tab outer radius', adv_ring_hint: 'ring outer edge; leave blank = no tab',
    ring_outer: 'Ring outer', ring_clear: 'Clear ring',
    mask_empty: 'Upload a drawing to preview its layers', vp_empty: 'Your 3D model appears here', vp_hint: 'Rotate · zoom · pan', vp_reset: 'Reset view',
    how_eyebrow: 'Under the hood', how_title: 'How it works', how_sub: 'A drawing goes through a real geometry pipeline — computer vision to manufacturable mesh.',
    how1_t: 'Input image', how1_b: 'A transparent-background PNG with dark line work.',
    how2_t: 'Silhouette detection', how2_b: 'OpenCV separates the artwork from the background by alpha.',
    how3_t: 'Contour tracing', how3_b: 'Dark regions are traced into closed polygons.',
    how4_t: 'Geometry smoothing', how4_b: 'Corner-cutting removes the pixel staircase from curves.',
    how5_t: 'Relief generation', how5_b: 'Regions are extruded into a base plate plus a raised relief layer.',
    how6_t: 'Printability check', how6_b: 'A keychain hole is placed clear of the artwork with a safe margin.',
    how7_t: 'STL export', how7_b: 'One two-layer STL — print with a single filament swap at the base height.',
    use_eyebrow: 'Applications', use_title: 'What can you make?',
    use1_t: 'Art', use1_b: 'Turn drawings and illustrations into physical artwork.',
    use2_t: 'Education', use2_b: "Turn students' drawings and designs into tangible objects.",
    use3_t: 'Tactile', use3_b: 'Explore turning visual artwork into raised, touchable forms.',
    use4_t: 'Prototyping', use4_b: 'Turn simple sketches into quick physical prototypes.',
    use5_t: 'Fan art', use5_b: 'Turn your favorite designs into physical keepsakes.',
    gallery_eyebrow: 'Examples', gallery_title: 'Made with SketchForge', gallery_sub: 'A few outputs from the pipeline. Load one into the tool and see how it was built.',
    gal1_name: 'Frame & text', gal1_type: 'line art · relief on base',
    gal2_name: 'Heart', gal2_type: 'solid silhouette',
    gal3_name: 'Line art', gal3_type: 'dense contours',
    gallery_try: 'Try it →', gallery_ph: 'Your drawing here', gallery_ph_cap: 'Community submissions — coming soon', gallery_ph_btn: 'Start with an example',
    about_eyebrow: 'Why it exists', about_title: 'About',
    about_1: 'This project started with a simple question: What if I could turn my fan art of Heeseung into a real 3D-printed keychain? EVAN, also known as Heeseung, is a solo singer under Belift Lab, is one of the subjects I especially enjoy drawing. After finishing a black-and-white chibi illustration, I manually traced it into vector geometry in Onshape and extruded it into a two-color 3D-printed keychain. It worked — but I quickly realized that manually tracing every illustration was tedious and difficult to scale.',
    about_2: 'So I decided to automate the process. The project now takes a transparent-background 2D artwork, extracts its contours and graphic regions, converts them into vector geometry, and generates a multi-layer model ready for 3D printing.',
    about_3: 'The goal is simple: Draw it → Upload it → Print it. What started as a way to turn one piece of fan art into something physical has grown into an exploration of computer vision, computational geometry, CAD, and digital fabrication.',
    about_tagline: 'Draw it → Upload it → Print it.',
    footer_tagline: 'From imagination to fabrication.', footer_meta: 'Built with OpenCV, shapely, trimesh & manifold3d.',
    pipe_1: 'Reading image', pipe_2: 'Detecting silhouette', pipe_3: 'Tracing contours', pipe_4: 'Smoothing geometry', pipe_5: 'Building relief', pipe_6: 'Exporting STL',
    upload_first: 'Upload a PNG or pick an example first.',
    gen_failed: 'Generation failed', analysis_failed: 'Analysis failed',
    network_error: 'Network error: ', stl_failed: 'Failed to load STL: ',
    done: 'Done', hole: 'hole', depth: 'depth', px: 'px',
    solid_note: 'Solid artwork · hole passes through the relief', dark_note: '{pct}% dark · hole avoids the artwork',
    switch_title: 'Switch images?', switch_body: '"{name}" hasn’t been generated yet — switching will discard it.',
    switch_gen: 'Generate current first', switch_discard: 'Discard & switch',
    gauge_base: 'Base', gauge_relief: 'Relief', gauge_swap: 'swap filament @ ', gauge_total: 'total',
  },
  zh: {
    nav_how: '工作原理', nav_use: '应用场景', nav_gallery: '示例', nav_about: '关于',
    cta_create: '创建 3D 模型', cta_how: '工作原理',
    hero_eyebrow: '2D 线稿 → 3D 浮雕 → 实体物件',
    hero_title: '把你的画变成实体物件。',
    hero_sub: 'SketchForge 把 2D 线稿变成可制造的 3D 模型——无需任何三维建模经验。',
    hv_drawing: '你的画', hv_layers: '识别出的分层', hv_printable: '可打印的浮雕',
    hv_base: '1.2 mm 底板', hv_relief: '0.6 mm 浮雕', hv_note: '一个 STL，一次换料。',
    forge_title: '创建你的模型', forge_sub: '上传一张透明背景、深色线稿的图片。', forge_note: '无需三维建模经验。',
    card_drawing: '图片', card_dims: '尺寸', card_colors: '颜色', card_section: '截面',
    drop_main: '把画拖到这里，或 ', drop_choose: '选择图片', drop_hint: 'PNG · 透明背景 · 深色线稿',
    examples_label: '示例', example_txt: '边框与文字', example_heart: '爱心', example_qban: '线稿',
    dim_width: '模型宽度', dim_base: '底板厚度', dim_relief: '浮雕厚度', dim_hole: '钥匙孔直径',
    chip_light: '浅色', chip_dark: '深色',
    adv_summary: '高级 · 阈值与孔位',
    adv_dark: '深色阈值', adv_dark_hint: '比此更暗的像素转为浮雕',
    adv_alpha: '透明阈值', adv_alpha_hint: '比此更不透明的像素转为底板',
    adv_hole: '孔位 X / Y', adv_hole_hint: '留空自动放置', hole_x_ph: 'X mm', hole_y_ph: 'Y mm',
    color_base: '底板', color_relief: '浮雕', color_note: '预览用色——实际打印颜色取决于你的耗材。',
    btn_generate: '生成 STL', btn_download: '下载 STL',
    seg_original: '原图', seg_layers: '分层', seg_base: '底板', seg_relief: '浮雕',
    orig_label: '原图', orig_hint: '参考', orig_toggle: '−',
    tool_hole: '圆孔',
    tool_select: '选择', tool_eraser: '橡皮擦', tool_draw: '画图形（即将）',
    zoom_fit: '适应',
    snap: '磁性', hole_pos_none: '未选中孔', canvas_hint: '滚轮缩放 · 拖拽平移',
    card_holes: '孔', new_hole_outer: '新挂耳外径', hole_invalid: '⚠ 无法打印——请在底板上选位置',
    adv_ring: '挂耳外半径', adv_ring_hint: '圆环外缘；留空=不加挂耳',
    ring_outer: '外圆', ring_clear: '清除圆环',
    mask_empty: '上传图片以预览分层', vp_empty: '3D 模型会显示在这里', vp_hint: '旋转 · 缩放 · 平移', vp_reset: '重置视角',
    how_eyebrow: '底层原理', how_title: '它是怎么工作的', how_sub: '一张画会经过一条真实的几何流水线——从计算机视觉到可制造的网格。',
    how1_t: '输入图片', how1_b: '一张透明背景、深色线稿的 PNG。',
    how2_t: '轮廓检测', how2_b: 'OpenCV 通过 alpha 通道把图案从背景中分离。',
    how3_t: '轮廓追踪', how3_b: '深色区域被追踪成闭合多边形。',
    how4_t: '几何平滑', how4_b: '削角平滑消除曲线上的像素阶梯。',
    how5_t: '浮雕生成', how5_b: '区域被拉伸成底板加凸起的浮雕层。',
    how6_t: '可打印性检查', how6_b: '钥匙孔被放置在避开图案、留足安全边距的位置。',
    how7_t: 'STL 导出', how7_b: '一个双层 STL——在底板高度处换一次料即可打印。',
    use_eyebrow: '应用场景', use_title: '你能做什么？',
    use1_t: '艺术', use1_b: '把画和插画变成实体艺术品。',
    use2_t: '教育', use2_b: '把学生的画作和设计变成可触摸的实物。',
    use3_t: '触感', use3_b: '把视觉作品变成凸起的、可触摸的形态。',
    use4_t: '原型', use4_b: '把简单草图变成快速实体原型。',
    use5_t: '同人周边', use5_b: '把你喜欢的设计变成实体收藏。',
    gallery_eyebrow: '示例', gallery_title: '用 SketchForge 做的', gallery_sub: '流水线的一些输出。载入一个到工具里看看它是怎么生成的。',
    gal1_name: '边框与文字', gal1_type: '线稿 · 底板上的浮雕',
    gal2_name: '爱心', gal2_type: '实心轮廓',
    gal3_name: '线稿', gal3_type: '密集轮廓',
    gallery_try: '试一试 →', gallery_ph: '把你的画放这里', gallery_ph_cap: '社区投稿——即将上线', gallery_ph_btn: '从示例开始',
    about_eyebrow: '它为什么存在', about_title: '关于',
    about_1: '这个项目最初来自一个很简单的想法：如果我画的李羲承（Heeseung）Q版同人图，可以直接变成一个真正的3D打印钥匙扣，会不会很酷？李羲承是Belift Lab旗下Solo艺人，也是我很喜欢的艺术创作对象之一。完成一张黑白线稿后，我尝试将它手动转换成 Onshape 中的矢量几何并进行挤出，最终成功制作出了双色3D打印钥匙扣。但我很快发现，手动描绘每一张图的轮廓非常耗时，而且完全无法扩展到更复杂的作品。',
    about_2: '于是，我开始尝试把这个过程程序化。现在，这个项目可以从带透明背景的2D artwork中自动提取轮廓和图案区域，将其转换为矢量几何，再生成可以直接用于3D打印的多层模型。',
    about_3: '我希望最终让这个过程变得简单：Draw it → Upload it → Print it。从一张我喜欢的同人图开始，这个项目逐渐变成了我对 computer vision、computational geometry、CAD 和 digital fabrication 的一次探索。',
    about_tagline: 'Draw it → Upload it → Print it.',
    footer_tagline: '从想象到制造。', footer_meta: '基于 OpenCV、shapely、trimesh 和 manifold3d 构建。',
    pipe_1: '读取图片', pipe_2: '检测轮廓', pipe_3: '追踪轮廓', pipe_4: '平滑几何', pipe_5: '生成浮雕', pipe_6: '导出 STL',
    upload_first: '请先上传一张 PNG 或选择示例。',
    gen_failed: '生成失败', analysis_failed: '分析失败',
    network_error: '网络错误：', stl_failed: '加载 STL 失败：',
    done: '完成', hole: '孔', depth: '总高', px: 'px',
    solid_note: '实心图案 · 孔穿过浮雕层', dark_note: '深色占比 {pct}% · 孔自动避开图案',
    switch_title: '切换图片？', switch_body: '「{name}」还没有生成模型，切换后会丢弃。',
    switch_gen: '先生成当前图', switch_discard: '直接切换',
    gauge_base: '底板', gauge_relief: '浮雕', gauge_swap: '换料 @ ', gauge_total: '总高',
  },
};
let LANG = localStorage.getItem('sketchforge_lang') || 'en';
function t(key) {
  return (I18N[LANG] && I18N[LANG][key]) ?? I18N.en[key] ?? key;
}
function applyLanguage() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.dataset.i18nPh)); });
  const toggle = $('#langToggle');
  if (toggle) toggle.textContent = LANG === 'en' ? '中文' : 'English';
  renderGauge();
}
function initLanguage() {
  const toggle = $('#langToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      LANG = LANG === 'en' ? 'zh' : 'en';
      localStorage.setItem('sketchforge_lang', LANG);
      applyLanguage();
      if (sourceFile) analyze();
    });
  }
  applyLanguage();
}

// ---------- generation pipeline (conceptual, honest) ----------
const PIPELINE_STAGES = ['pipe_1', 'pipe_2', 'pipe_3', 'pipe_4', 'pipe_5', 'pipe_6'];
let pipelineTimer = null;
function startPipeline() {
  let i = 0;
  setStatus(t(PIPELINE_STAGES[0]) + '…', '');
  pipelineTimer = setInterval(() => {
    i = (i + 1) % PIPELINE_STAGES.length;
    setStatus(t(PIPELINE_STAGES[i]) + '…', '');
  }, 160);
}
function stopPipeline() {
  if (pipelineTimer) { clearInterval(pipelineTimer); pipelineTimer = null; }
}

// ---------- pipeline calls ----------
async function analyze() {
  if (!sourceFile) return;
  const fd = new FormData();
  fd.append('file', sourceFile, 'upload.png');
  fd.append('dark_threshold', String(int($('#darkThreshold'))));
  fd.append('alpha_threshold', String(int($('#alphaThreshold'))));
  fd.append('base_color', baseHex());
  fd.append('color_color', colorHex());
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) { setStatus(data.error || t('analysis_failed'), 'err'); return; }
    analysis = data;
    $('#stageMeta').textContent = `${data.w_px} × ${data.h_px} ${t('px')}`;
    basePoly = data.base_poly || [];
    holes = []; selectedHoleId = null;
    $('#holeCard').hidden = false;
    $('#maskEmpty').hidden = true;
    renderHoleList();
    updateHoleMessage();
    updateHolePos();
    refreshLayerPanel();
    loadLayerPreview();
    fitCanvas();
  } catch (e) {
    setStatus(t('network_error') + e.message, 'err');
  }
}

async function generate() {
  if (!sourceFile) { setStatus(t('upload_first'), 'err'); return false; }
  const fd = new FormData();
  fd.append('file', sourceFile, 'upload.png');
  fd.append('width', String(num($('#width'))));
  fd.append('base', String(num($('#base'))));
  fd.append('color', String(num($('#color'))));
  fd.append('hole', String(num($('#hole'))));
  if (holes.length) {
    fd.append('holes', JSON.stringify(holes.map(h => [h.x, h.y, h.outer ?? null])));
  }
  fd.append('dark_threshold', String(int($('#darkThreshold'))));
  fd.append('alpha_threshold', String(int($('#alphaThreshold'))));

  startPipeline();
  const btn = $('#generateBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/generate', { method: 'POST', body: fd });
    if (!res.ok) {
      stopPipeline();
      let msg = t('gen_failed');
      try { msg = (await res.json()).error || msg; } catch (_) {}
      setStatus(msg, 'err');
      return false;
    }
    const blob = await res.blob();
    stopPipeline();
    stlBlob = blob;
    committedSourceName = sourceName;
    const hc = res.headers.get('X-Hole-Center');
    holeCenter = hc ? hc.split(',').map(Number) : null;

    loadStl(blob, num($('#base')));
    $('#downloadBtn').disabled = false;

    const total = num($('#base')) + num($('#color'));
    let msg = t('done') + ' · ' + fmtSize(blob.size);
    if (holeCenter) msg += ' · ' + t('hole') + ` (${holeCenter[0].toFixed(1)}, ${holeCenter[1].toFixed(1)})`;
    setStatus(msg, 'ok');
    if (holeCenter) {
      $('#vpInfo').innerHTML =
        `${t('hole')} <b>(${holeCenter[0].toFixed(1)}, ${holeCenter[1].toFixed(1)})</b> mm · ${t('depth')} <b>${total.toFixed(1)}</b> mm`;
    }
    return true;
  } catch (e) {
    stopPipeline();
    setStatus(t('network_error') + e.message, 'err');
    return false;
  } finally {
    stopPipeline();
    btn.disabled = false;
  }
}

function download() {
  if (!stlBlob) return;
  const base = (sourceName || 'keychain').replace(/\.[^.]+$/, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(stlBlob);
  a.download = base + '.stl';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- source selection ----------
function setSource(file, name) {
  // Uncommitted current image? Ask before discarding it.
  if (sourceFile && sourceName !== committedSourceName) {
    pendingSource = { file, name };
    showModal({
      title: t('switch_title'),
      body: t('switch_body').replace('{name}', sourceName),
      buttons: [
        { label: t('switch_gen'), primary: true, onClick: generateThenSwitch },
        { label: t('switch_discard'), onClick: commitSwitch },
      ],
    });
    return;
  }
  applySource(file, name);
}

function commitSwitch() {
  if (!pendingSource) return;
  const { file, name } = pendingSource;
  pendingSource = null;
  applySource(file, name);
}

async function generateThenSwitch() {
  const ok = await generate();
  if (ok) download();
  commitSwitch();
}

function applySource(file, name) {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceFile = file;
  sourceName = name;
  sourceUrl = URL.createObjectURL(file);
  analysis = null;
  holeSeq = 1;
  holes = []; selectedHoleId = null; basePoly = [];
  setTool('select');
  editorImg.src = '';
  $('#holeCard').hidden = true;
  $('#maskEmpty').hidden = false;
  $('#originalImg').src = sourceUrl;
  $('#origThumb').hidden = false;
  renderHoleList();
  updateHoleMessage();
  $('#stageMeta').textContent = name;
  analyze();
}

// ---------- modal ----------
function showModal({ title, body, buttons }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  const actions = $('#modalActions');
  actions.innerHTML = '';
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (b.primary ? 'btn-primary' : 'btn-ghost');
    btn.textContent = b.label;
    btn.addEventListener('click', () => { hideModal(); b.onClick && b.onClick(); });
    actions.appendChild(btn);
  });
  $('#modal').hidden = false;
}
function hideModal() { $('#modal').hidden = true; }

// ---------- hero + gallery ----------
async function initHero() {
  try {
    const r = await fetch('/api/examples/txt');
    const blob = await r.blob();
    const orig = $('#heroOriginal');
    if (orig) orig.src = URL.createObjectURL(blob);
    const fd = new FormData();
    fd.append('file', blob, 'upload.png');
    const ar = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await ar.json();
    const layers = $('#heroLayers');
    if (layers && data.ok) layers.src = data.combined_png;
  } catch (_) { /* hero is decorative; ignore failures */ }
}

function initGallery() {
  document.querySelectorAll('[data-example]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.example;
      const r = await fetch('/api/examples/' + encodeURIComponent(id));
      const blob = await r.blob();
      setSource(blob, (t('example_' + id) || id) + '.png');
      const forge = $('#forge');
      if (forge) forge.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

// ---------- examples ----------
async function loadExamples() {
  try {
    const res = await fetch('/api/examples');
    const list = await res.json();
    const box = $('#examples');
    if (!list.length) return;
    for (const ex of list) {
      const label = t('example_' + ex.id) || ex.name;
      const b = el('button', 'example-btn');
      b.setAttribute('data-i18n', 'example_' + ex.id);
      b.textContent = label;
      b.addEventListener('click', async () => {
        const r = await fetch('/api/examples/' + encodeURIComponent(ex.id));
        const blob = await r.blob();
        setSource(blob, label + '.png');
      });
      box.appendChild(b);
    }
  } catch (_) { /* examples are optional */ }
}

// ---------- wiring ----------
function bindPair(numSel, rangeSel, onChange) {
  const n = $(numSel), r = $(rangeSel);
  r.addEventListener('input', () => { n.value = r.value; onChange(); });
  n.addEventListener('input', () => { if (n.value !== '') r.value = n.value; onChange(); });
}

let analyzeTimer = null;
function scheduleAnalyze() { clearTimeout(analyzeTimer); analyzeTimer = setTimeout(analyze, 350); }

function setupDropzone() {
  const dz = $('#dropzone');
  const input = $('#fileInput');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setSource(f, f.name);
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) setSource(input.files[0], input.files[0].name);
  });
}

function init() {
  initThree();
  setupDropzone();
  loadExamples();
  initHero();
  initGallery();
  initTheme();
  initLanguage();

  // layers (PS-style, preview-only) + editor canvas + tools + original + holes
  $('#layerBaseEye').addEventListener('click', onLayerToggle);
  $('#layerReliefEye').addEventListener('click', onLayerToggle);
  setupCanvas();
  ['select', 'hole', 'eraser'].forEach(n => {
    const b = $('#tool' + n.charAt(0).toUpperCase() + n.slice(1));
    if (b) b.addEventListener('click', () => setTool(n));
  });
  $('#zoomIn').addEventListener('click', () => zoomBy(1.2));
  $('#zoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
  $('#zoomFit').addEventListener('click', fitCanvas);
  $('#snapToggle').addEventListener('click', () => {
    snapEnabled = !snapEnabled;
    $('#snapToggle').classList.toggle('is-active', snapEnabled);
    $('#snapToggle').setAttribute('aria-pressed', String(snapEnabled));
  });
  $('#newHoleOuter').addEventListener('input', () => {
    if (!analysis) return;
    const sel = holes.find(h => h.id === selectedHoleId);
    if (sel) { snapshotHoles(); sel.outer = $('#newHoleOuter').value === '' ? null : num($('#newHoleOuter')); recompute(); }
  });
  $('#holeClear').addEventListener('click', clearHoles);
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey, tg = e.target && e.target.tagName;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redoHoles() : undoHoles(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoHoles(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && activeTool === 'select' && tg !== 'INPUT') deleteSelectedHole();
  });
  window.addEventListener('resize', () => { if (analysis) fitCanvas(); });

  // params -> gauge
  bindPair('#width', '#widthRange', () => { renderGauge(); if (analysis) renderCanvas(); });
  bindPair('#base', '#baseRange', renderGauge);
  bindPair('#color', '#colorRange', renderGauge);
  $('#hole').addEventListener('input', () => { snapshotHoles(); holes.forEach(h => { h.inner = num($('#hole')) / 2; }); renderGauge(); recompute(); });

  // thresholds -> re-analyze (debounced)
  bindPair('#darkThreshold', '#darkThresholdRange', scheduleAnalyze);
  bindPair('#alphaThreshold', '#alphaThresholdRange', scheduleAnalyze);

  // colours -> re-tint previews + 3D model
  $('#baseColor').addEventListener('input', onColorChange);
  $('#colorColor').addEventListener('input', onColorChange);

  // actions
  $('#generateBtn').addEventListener('click', generate);
  $('#downloadBtn').addEventListener('click', download);
  $('#resetView').addEventListener('click', fitCamera);
  $('#modal').querySelector('.modal-backdrop').addEventListener('click', hideModal);

  renderGauge();
}

init();
