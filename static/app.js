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
let defaultHoleSeeded = false;  // auto-hole placed once per source; stays true if user deletes it
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
  const invalid = holes.some(h => !h.valid);
  if (analysis && invalid) {
    $('#holeMessageText').textContent = t('hole_invalid');   // "cannot print, choose a suitable position"
    msg.classList.add('bad'); msg.hidden = false;
  } else { msg.hidden = true; msg.classList.remove('bad', 'shake'); }
}
function hasInvalidHole() { return holes.some(h => !h.valid); }
function shakeHoleMessage() {
  const msg = $('#holeMessage');
  updateHoleMessage();
  msg.classList.remove('shake'); void msg.offsetWidth; msg.classList.add('shake');
}
function resetInvalidHoles() {
  snapshotHoles();
  holes.forEach(h => { if (!h.valid) { h.x = 0; h.y = 0; } });
  recompute();
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
  // A non-printable hole must be reset before any further editing
  if (hasInvalidHole() && activeTool !== 'eraser') { shakeHoleMessage(); return; }
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
const THEME_KEY = 'drafterflow_theme';
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
    hero_eyebrow: 'A drawing, made physical.',
    hero_title: 'Turn your drawings into physical objects.',
    hero_sub: 'DrafterFlow turns 2D drawings into 3D-printable objects. No CAD experience required.',
    hv_drawing: 'Your drawing', hv_layers: 'Detected layers', hv_printable: 'Printable relief',
    hv_base: '4 mm base', hv_relief: '2 mm relief', hv_note: 'One STL, one filament swap.',
    forge_title: 'Create your model', forge_sub: 'Upload a drawing with a transparent background and dark line work.', forge_note: 'No 3D modeling experience required.',
    card_drawing: 'Drawing', card_dims: 'Dimensions', card_colors: 'Colors', card_section: 'Cross-section',
    drop_main: 'Drop your drawing here, or ', drop_choose: 'choose an image', drop_hint: 'PNG · transparent background · dark line art',
    examples_label: 'Examples', example_nametag: 'Nametag', example_heart: 'Heart', example_qban: 'Line art',
    dim_width: 'Model width', dim_base: 'Base thickness', dim_relief: 'Relief thickness', dim_hole: 'Keychain hole',
    chip_light: 'light', chip_dark: 'dark',
    adv_summary: 'Advanced · thresholds & hole position',
    adv_dark: 'Dark threshold', adv_dark_hint: 'pixels darker than this become relief',
    adv_alpha: 'Alpha threshold', adv_alpha_hint: 'pixels more opaque than this become the base',
    adv_hole: 'Hole X / Y', adv_hole_hint: 'leave blank to auto-place', hole_x_ph: 'X mm', hole_y_ph: 'Y mm',
    color_base: 'Base', color_relief: 'Relief', color_note: 'Preview colors. The real print color comes from your filament.',
    btn_generate: 'Generate STL', btn_download: 'Download STL',
    seg_original: 'Original', seg_layers: 'Layers', seg_base: 'Base', seg_relief: 'Relief',
    orig_label: 'Original', orig_hint: 'reference', orig_toggle: '−',
    tool_hole: 'Hole',
    tool_select: 'Select', tool_eraser: 'Eraser', tool_draw: 'Draw (soon)',
    zoom_fit: 'Fit',
    snap: 'Magnetic', hole_pos_none: 'No hole selected', canvas_hint: 'scroll to zoom · drag to pan',
    card_holes: 'Holes', new_hole_outer: 'New ring outer', hole_invalid: '⚠ cannot print. Pick a position on the base', hole_reset: 'Reset position',
    adv_ring: 'Hang-tab outer radius', adv_ring_hint: 'ring outer edge; leave blank = no tab',
    ring_outer: 'Ring outer', ring_clear: 'Clear ring', hole_none: 'no keyhole',
    mask_empty: 'Upload a drawing to preview its layers', vp_empty: 'Your 3D model appears here', vp_hint: 'Rotate · zoom · pan', vp_reset: 'Reset view',
    how_eyebrow: 'Under the hood', how_title: 'How it works', how_sub: 'A drawing goes through a real geometry pipeline: computer vision to a printable mesh.',
    how1_t: 'Input image', how1_b: 'A transparent-background PNG with dark line work.',
    how2_t: 'Silhouette detection', how2_b: 'OpenCV separates the artwork from the background by alpha.',
    how3_t: 'Contour tracing', how3_b: 'Dark regions are traced into closed polygons.',
    how4_t: 'Geometry smoothing', how4_b: 'Corner-cutting removes the pixel staircase from curves.',
    how5_t: 'Relief generation', how5_b: 'Regions are extruded into a base plate plus a raised relief layer.',
    how6_t: 'Printability check', how6_b: 'A keychain hole is placed clear of the artwork with a safe margin.',
    how7_t: 'STL export', how7_b: 'One two-layer STL: print with a single filament swap at the base height.',
    use_eyebrow: 'Applications', use_title: 'What can you make?',
    use1_t: 'Art', use1_b: 'Turn drawings and illustrations into physical artwork.',
    use2_t: 'Education', use2_b: "Turn students' drawings and designs into tangible objects.",
    use3_t: 'Tactile', use3_b: 'Explore turning visual artwork into raised, touchable forms.',
    use4_t: 'Prototyping', use4_b: 'Turn simple sketches into quick physical prototypes.',
    use5_t: 'Fan art', use5_b: 'Turn your favorite designs into physical keepsakes.',
    gallery_eyebrow: 'Examples', gallery_title: 'Made with DrafterFlow', gallery_sub: 'A few outputs from the pipeline. Load one into the tool and see how it was built.',
    gal1_name: 'Frame & text', gal1_type: 'line art · relief on base',
    gal2_name: 'Heart', gal2_type: 'solid silhouette',
    gal3_name: 'Line art', gal3_type: 'dense contours',
    gallery_try: 'Try it', gallery_ph: 'Your drawing here', gallery_ph_cap: 'Community submissions, coming soon', gallery_ph_btn: 'Start with an example',
    about_eyebrow: 'Why it exists', about_title: 'About',
    about_1: 'I drew a chibi of Heeseung and wanted it as a real 3D-printed keychain. Tracing the line art by hand in Onshape took hours and wouldn’t scale to the next drawing, so I built DrafterFlow to do it instead.',
    about_2: 'It reads an image the way a person would: the silhouette becomes a white base plate, the dark strokes a raised layer. One STL, two colours, one filament swap.',
    about_3: 'What started as one piece of fan art is now a way to turn drawings into physical things.',
    about_tagline: 'Draw it. Upload it. Print it.',
    footer_tagline: 'From imagination to fabrication.', footer_meta: 'Built with OpenCV, shapely, trimesh & manifold3d.',
    pipe_1: 'Reading image', pipe_2: 'Detecting silhouette', pipe_3: 'Tracing contours', pipe_4: 'Smoothing geometry', pipe_5: 'Building relief', pipe_6: 'Exporting STL',
    upload_first: 'Upload a PNG or pick an example first.',
    gen_failed: 'Generation failed', analysis_failed: 'Analysis failed',
    network_error: 'Network error: ', stl_failed: 'Failed to load STL: ',
    done: 'Done', hole: 'hole', depth: 'depth', px: 'px',
    solid_note: 'Solid artwork · hole passes through the relief', dark_note: '{pct}% dark · hole avoids the artwork',
    switch_title: 'Switch images?', switch_body: '"{name}" hasn’t been generated yet. Switching will discard it.',
    switch_gen: 'Generate current first', switch_discard: 'Discard & switch',
    gauge_base: 'Base', gauge_relief: 'Relief', gauge_swap: 'swap filament @ ', gauge_total: 'total',
  },
  zh: {
    nav_how: '工作原理', nav_use: '应用场景', nav_gallery: '示例', nav_about: '关于',
    cta_create: '创建 3D 模型', cta_how: '工作原理',
    hero_eyebrow: '一张画，变成实物。',
    hero_title: '把你的画变成实体物件。',
    hero_sub: 'DrafterFlow 把 2D 线稿变成可 3D 打印的实体物件。无需任何三维建模经验。',
    hv_drawing: '你的画', hv_layers: '识别出的分层', hv_printable: '可打印的浮雕',
    hv_base: '4 mm 底板', hv_relief: '2 mm 浮雕', hv_note: '一个 STL，一次换料。',
    forge_title: '创建你的模型', forge_sub: '上传一张透明背景、深色线稿的图片。', forge_note: '无需三维建模经验。',
    card_drawing: '图片', card_dims: '尺寸', card_colors: '颜色', card_section: '截面',
    drop_main: '把画拖到这里，或 ', drop_choose: '选择图片', drop_hint: 'PNG · 透明背景 · 深色线稿',
    examples_label: '示例', example_nametag: '名牌', example_heart: '爱心', example_qban: '线稿',
    dim_width: '模型宽度', dim_base: '底板厚度', dim_relief: '浮雕厚度', dim_hole: '钥匙孔直径',
    chip_light: '浅色', chip_dark: '深色',
    adv_summary: '高级 · 阈值与孔位',
    adv_dark: '深色阈值', adv_dark_hint: '比此更暗的像素转为浮雕',
    adv_alpha: '透明阈值', adv_alpha_hint: '比此更不透明的像素转为底板',
    adv_hole: '孔位 X / Y', adv_hole_hint: '留空自动放置', hole_x_ph: 'X mm', hole_y_ph: 'Y mm',
    color_base: '底板', color_relief: '浮雕', color_note: '预览用色。实际打印颜色取决于你的耗材。',
    btn_generate: '生成 STL', btn_download: '下载 STL',
    seg_original: '原图', seg_layers: '分层', seg_base: '底板', seg_relief: '浮雕',
    orig_label: '原图', orig_hint: '参考', orig_toggle: '−',
    tool_hole: '圆孔',
    tool_select: '选择', tool_eraser: '橡皮擦', tool_draw: '画图形（即将）',
    zoom_fit: '适应',
    snap: '磁性', hole_pos_none: '未选中孔', canvas_hint: '滚轮缩放 · 拖拽平移',
    card_holes: '孔', new_hole_outer: '新挂耳外径', hole_invalid: '⚠ 无法打印。请在底板上选位置', hole_reset: '重置位置',
    adv_ring: '挂耳外半径', adv_ring_hint: '圆环外缘；留空=不加挂耳',
    ring_outer: '外圆', ring_clear: '清除圆环', hole_none: '无钥匙孔',
    mask_empty: '上传图片以预览分层', vp_empty: '3D 模型会显示在这里', vp_hint: '旋转 · 缩放 · 平移', vp_reset: '重置视角',
    how_eyebrow: '底层原理', how_title: '它是怎么工作的', how_sub: '一张画会经过一条真实的几何流水线：从计算机视觉到可打印的网格。',
    how1_t: '输入图片', how1_b: '一张透明背景、深色线稿的 PNG。',
    how2_t: '轮廓检测', how2_b: 'OpenCV 通过 alpha 通道把图案从背景中分离。',
    how3_t: '轮廓追踪', how3_b: '深色区域被追踪成闭合多边形。',
    how4_t: '几何平滑', how4_b: '削角平滑消除曲线上的像素阶梯。',
    how5_t: '浮雕生成', how5_b: '区域被拉伸成底板加凸起的浮雕层。',
    how6_t: '可打印性检查', how6_b: '钥匙孔被放置在避开图案、留足安全边距的位置。',
    how7_t: 'STL 导出', how7_b: '一个双层 STL：在底板高度处换一次料即可打印。',
    use_eyebrow: '应用场景', use_title: '你能做什么？',
    use1_t: '艺术', use1_b: '把画和插画变成实体艺术品。',
    use2_t: '教育', use2_b: '把学生的画作和设计变成可触摸的实物。',
    use3_t: '触感', use3_b: '把视觉作品变成凸起的、可触摸的形态。',
    use4_t: '原型', use4_b: '把简单草图变成快速实体原型。',
    use5_t: '同人周边', use5_b: '把你喜欢的设计变成实体收藏。',
    gallery_eyebrow: '示例', gallery_title: '用 DrafterFlow 做的', gallery_sub: '流水线的一些输出。载入一个到工具里看看它是怎么生成的。',
    gal1_name: '边框与文字', gal1_type: '线稿 · 底板上的浮雕',
    gal2_name: '爱心', gal2_type: '实心轮廓',
    gal3_name: '线稿', gal3_type: '密集轮廓',
    gallery_try: '试一试', gallery_ph: '把你的画放这里', gallery_ph_cap: '社区投稿，即将上线', gallery_ph_btn: '从示例开始',
    about_eyebrow: '它为什么存在', about_title: '关于',
    about_1: '我画了一张李羲承（Heeseung）的 Q 版图，想把它做成真正的 3D 打印钥匙扣。在 Onshape 里手动描线太耗时、也不好扩展，于是我做了 DrafterFlow。',
    about_2: '它像人一样看待一张图：轮廓变成白色底板，深色线条变成凸起的一层。一个 STL，两种颜色，换一次料。',
    about_3: '从一个同人图开始，现在它变成了把画变成实物的工具。',
    about_tagline: '画它 · 上传它 · 打印它。',
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
let LANG = localStorage.getItem('drafterflow_lang') || 'en';
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
      localStorage.setItem('drafterflow_lang', LANG);
      applyLanguage();
      syncOrigThumb();
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
  fd.append('width', String(num($('#width'))));
  fd.append('hole', String(num($('#hole'))));
  fd.append('base_color', baseHex());
  fd.append('color_color', colorHex());
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) { setStatus(data.error || t('analysis_failed'), 'err'); return; }
    analysis = data;
    $('#stageMeta').textContent = `${data.w_px} × ${data.h_px} ${t('px')}`;
    basePoly = data.base_poly || [];
    // Auto-place the default keyhole on the canvas once per source (a fresh source
    // starts with no holes). Re-analyzes keep existing holes so adjusting a threshold
    // or colour doesn't discard the user's placement.
    if (!defaultHoleSeeded) {
      if (data.default_hole) {
        const r = num($('#hole')) / 2;
        holes.push({ id: holeSeq++, x: data.default_hole[0], y: data.default_hole[1], outer: null, inner: r, valid: true });
        selectedHoleId = holes[holes.length - 1].id;
      }
      defaultHoleSeeded = true;
    }
    $('#holeCard').hidden = false;
    $('#maskEmpty').hidden = true;
    recompute();
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
  // Always send the placements; an empty array means "no keyhole".
  fd.append('holes', JSON.stringify(holes.map(h => [h.x, h.y, h.outer ?? null])));
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
    if (holeCenter) {
      msg += ' · ' + t('hole') + ` (${holeCenter[0].toFixed(1)}, ${holeCenter[1].toFixed(1)})`;
      $('#vpInfo').innerHTML =
        `${t('hole')} <b>(${holeCenter[0].toFixed(1)}, ${holeCenter[1].toFixed(1)})</b> mm · ${t('depth')} <b>${total.toFixed(1)}</b> mm`;
    } else {
      msg += ' · ' + t('hole_none');
      $('#vpInfo').innerHTML = `${t('depth')} <b>${total.toFixed(1)}</b> mm · ${t('hole_none')}`;
    }
    setStatus(msg, 'ok');
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

function syncOrigThumb() {
  // Size the original-image square to the width of the Base/Relief layer panel so the
  // preview lines up with the two layer rows beside it. No-op until a source is loaded.
  const thumb = $('#origThumb');
  const panel = document.querySelector('.layer-panel');
  if (!thumb || thumb.hidden || !panel) return;
  const w = Math.max(96, Math.round(panel.getBoundingClientRect().width));
  thumb.style.width = w + 'px';
  thumb.style.height = w + 'px';
}

function applySource(file, name) {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceFile = file;
  sourceName = name;
  sourceUrl = URL.createObjectURL(file);
  analysis = null;
  holeSeq = 1;
  holes = []; selectedHoleId = null; basePoly = [];
  defaultHoleSeeded = false;
  setTool('select');
  editorImg.src = '';
  $('#holeCard').hidden = true;
  $('#maskEmpty').hidden = false;
  $('#originalImg').src = sourceUrl;
  $('#origThumb').hidden = false;
  syncOrigThumb();
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
    const r = await fetch('/api/examples/nametag');
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

// ---------- Color Layer Mode ----------
// This is intentionally separate from the line-art editor above.  The two modes
// share visual tokens and STL infrastructure, but their input semantics are quite
// different: line mode extracts a silhouette + dark strokes, while color mode
// presents non-semantic palette masks that the user orders explicitly.
let activeMode = 'line';
let colorSourceFile = null;
let colorSourceUrl = null;
let colorSourceName = '';
let colorAnalysis = null;
let colorPalette = []; // bottom -> top: { id, rgb, lab, mask_png, pixel_count, ignored, visible }
let colorMaskImages = new Map();
let colorMaskAlpha = new Map();
let colorStlBlob = null;
let backgroundCandidateId = null;
let colorBackgroundRemoved = false;
let colorPreviewMode = 'print', previewLayerId = null;
let regionSelecting = false, regionTargetId = null;
let selectedColorRegions = new Set();
let colorRegionPixels = null, colorRegionOwners = new Map();
let colorSelectionOverlay = null, colorPrintPreview = null;
let colorCanvas, colorCtx;
let colorView = { zoom: 1, ox: 0, oy: 0 };
let colorHolePlacing = false;
let colorRenderer, colorScene, colorCamera, colorControls, colorModelGroup, colorGrid;

function setColorStatus(message, kind = '') {
  const node = $('#colorStatus');
  node.textContent = message;
  node.className = 'status' + (kind ? ' ' + kind : '');
}

function setWorkbenchMode(mode) {
  activeMode = mode;
  const isColor = mode === 'color';
  $('#lineWorkbench').hidden = isColor;
  $('#colorWorkbench').hidden = !isColor;
  $('#lineModeTab').classList.toggle('is-active', !isColor);
  $('#colorModeTab').classList.toggle('is-active', isColor);
  $('#lineModeTab').setAttribute('aria-selected', String(!isColor));
  $('#colorModeTab').setAttribute('aria-selected', String(isColor));
  const sub = document.querySelector('.forge-sub');
  const note = document.querySelector('.forge-note');
  if (isColor) {
    sub.textContent = 'Upload a flat-colour illustration, inspect its masks, then choose the stepped relief order.';
    note.textContent = 'Order printable layers; the same colour can appear at several heights.';
    requestAnimationFrame(() => { resizeColorThree(); if (colorAnalysis) fitColorCanvas(); });
  } else {
    sub.textContent = t('forge_sub');
    note.textContent = t('forge_note');
  }
  scheduleColorDraftPersist();
}

function colorActivePalette() {
  return colorPalette.filter((entry) => !entry.ignored && entry.pixel_count > 0);
}

function colorDimensionValues() {
  return {
    width: Math.max(0, num($('#colorWidth'))),
    base: Math.max(0, num($('#colorBase'))),
    increment: Math.max(0, num($('#colorIncrement'))),
    slicer: Math.max(0, num($('#colorSlicerLayer'))),
  };
}

function invalidateColorStl() {
  colorStlBlob = null;
  $('#colorDownloadBtn').disabled = true;
  if (colorModelGroup) {
    while (colorModelGroup.children.length) {
      const part = colorModelGroup.children[0];
      colorModelGroup.remove(part);
      part.geometry.dispose(); part.material.dispose();
    }
  }
  if (colorGrid) colorGrid.visible = false;
  $('#colorVpEmpty').hidden = false;
  $('#colorResetView').hidden = true;
  $('#colorVpInfo').hidden = true;
}

function setColorSource(file, name, options = {}) {
  if (!file) return;
  if (!isRestoringColorDraft) { savedColorPalette = null; $('#colorHoleEnabled').checked = false; $('#colorHoleX').value = '0'; $('#colorHoleY').value = '0'; colorHolePlacing = false; }
  if (colorSourceUrl) URL.revokeObjectURL(colorSourceUrl);
  colorSourceFile = file;
  colorSourceDataUrl = null;
  colorSourceName = name || 'illustration';
  colorSourceUrl = URL.createObjectURL(file);
  colorAnalysis = null;
  colorPalette = [];
  backgroundCandidateId = null;
  colorBackgroundRemoved = options.removeBackground === true;
  colorMaskImages.clear();
  colorMaskAlpha.clear();
  colorRegionPixels = null; selectedColorRegions.clear(); regionSelecting = false;
  previewLayerId = null; regionTargetId = null;
  invalidateColorStl();
  $('#colorOriginalImg').src = colorSourceUrl;
  $('#colorOrigThumb').hidden = false;
  $('#colorStageMeta').textContent = colorSourceName;
  $('#colorMaskEmpty').hidden = false;
  $('#colorMaskEmpty').textContent = 'Analyzing flat colours…';
  renderColorPalette();
  rememberColorSource(file);
  return analyzeColorLayers();
}

function imageFromSource(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function analyzeColorLayers(options = {}) {
  if (!colorSourceFile) { setColorStatus('Upload a flat-colour illustration first.', 'err'); return; }
  if (colorPalette.length && options.resetLayers !== true) savedColorPalette = serializablePalette();
  const fd = new FormData();
  fd.append('file', colorSourceFile, colorSourceName || 'illustration.png');
  fd.append('palette_size', $('#colorPaletteSize').value);
  fd.append('alpha_threshold', '8');
  fd.append('cleanup_min_area', String(Math.max(0, int($('#colorCleanup')))));
  fd.append('width', String(Math.max(1, num($('#colorWidth')))));
  fd.append('remove_background', String(colorBackgroundRemoved));
  if (options.preservePalette === true && colorPalette.length) {
    fd.append('palette', JSON.stringify(colorAnalysis.palette));
  }
  const button = $('#colorAnalyzeBtn');
  button.disabled = true;
  setColorStatus('Quantizing colours and tracing mask previews…');
  try {
    const response = await fetch('/api/color/analyze', { method: 'POST', body: fd });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Color analysis failed.');
    colorAnalysis = data;
    invalidateColorStl();
    colorBackgroundRemoved = data.background_removed === true;
    colorPalette = data.palette.map((entry) => ({
      ...entry,
      source_color_id: entry.id, region_seeds: null, excluded_region_seeds: [],
      // Cleanup may remove an entire sparse palette entry. Keep it inspectable
      // rather than silently reordering the palette, but never give it a height.
      ignored: entry.pixel_count === 0,
      visible: entry.pixel_count > 0,
    }));
    chooseBackgroundCandidate();
    colorMaskImages.clear();
    colorMaskAlpha.clear();
    const regionImage = await imageFromSource(data.region_map_png);
    const regionCanvas = document.createElement('canvas'); regionCanvas.width = data.w_px; regionCanvas.height = data.h_px;
    const regionContext = regionCanvas.getContext('2d', { willReadFrequently: true }); regionContext.drawImage(regionImage, 0, 0);
    colorRegionPixels = regionContext.getImageData(0, 0, data.w_px, data.h_px).data;
    applySavedColorPalette();
    selectedColorRegions.clear(); colorSelectionOverlay = null;
    rebuildColorLayerMasks();
    $('#colorMaskEmpty').hidden = true;
    $('#colorStageMeta').textContent = `${data.palette.length} model colours · ${data.w_px} × ${data.h_px} px`;
    $('#colorStageMeta').title = `The source has ${data.source_color_count >= 999 ? '999+' : data.source_color_count} shades, including smooth edge pixels. These are reduced to the selected model colours.`;
    renderColorPalette();
    renderColorLayers();
    updateColorMetrics();
    fitColorCanvas();
    setColorStatus(`Detected ${data.palette.length} source colours · ${colorActivePalette().length} printable layers · reorder bottom to top.`, 'ok');
    scheduleColorDraftPersist();
    return true;
  } catch (error) {
    $('#colorMaskEmpty').hidden = false;
    $('#colorMaskEmpty').textContent = 'Unable to build colour masks';
    setColorStatus(error.message || 'Color analysis failed.', 'err');
    return false;
  } finally {
    button.disabled = false;
  }
}

function renderColorPalette() {
  const list = $('#colorPaletteList');
  list.innerHTML = '';
  if (!colorPalette.length) {
    const empty = el('p', 'palette-empty');
    empty.textContent = colorSourceFile ? 'Analyzing palette…' : 'Upload a flat-colour illustration to detect its palette.';
    list.appendChild(empty);
    updateBackgroundTools();
    return;
  }
  colorPalette.forEach((entry, index) => {
    const row = el('div', 'palette-layer' + (entry.ignored ? ' is-ignored' : ''));
    const swatch = el('span', 'palette-swatch');
    swatch.style.background = entry.hex;
    const name = el('span', 'palette-layer-name');
    const label = document.createElement('input'); label.value = colorLayerName(entry, index);
    label.setAttribute('aria-label', `Name of layer ${index + 1}`); label.maxLength = 80;
    label.addEventListener('change', () => { entry.name = label.value.trim() || `Layer ${index + 1}`; renderColorLayers(); renderColorPlan(); updateColorLayerControls(); scheduleColorDraftPersist(); });
    const pixels = document.createElement('span');
    pixels.textContent = `${entry.pixel_count.toLocaleString()} px`;
    name.append(label, pixels);
    const use = el('button', 'palette-icon');
    use.type = 'button';
    use.title = entry.ignored ? 'Include this colour in the model' : 'Ignore this colour (for example, a flat background)';
    use.textContent = entry.ignored ? 'Use' : 'Ignore';
    use.disabled = entry.pixel_count === 0;
    use.addEventListener('click', () => {
      entry.ignored = !entry.ignored;
      invalidateColorStl();
      renderColorPalette(); renderColorLayers(); renderColorPlan(); renderColorCanvas();
      scheduleColorDraftPersist();
    });
    const actions = el('span', 'palette-actions');
    const up = el('button', 'palette-order');
    up.type = 'button'; up.textContent = '↑'; up.title = 'Move lower'; up.disabled = index === 0;
    up.addEventListener('click', () => moveColorLayer(index, -1));
    const down = el('button', 'palette-order');
    down.type = 'button'; down.textContent = '↓'; down.title = 'Move higher'; down.disabled = index === colorPalette.length - 1;
    down.addEventListener('click', () => moveColorLayer(index, 1));
    actions.append(up, down);
    row.append(swatch, name, use, actions);
    list.appendChild(row);
  });
  updateBackgroundTools();
  updateColorLayerControls();
}

function colorLayerName(entry, index = colorPalette.indexOf(entry)) { return entry.name || `Layer ${index + 1}`; }
function seedKey(seed) { return `${seed[0]}:${seed[1]}`; }

function rebuildColorLayerMasks() {
  if (!colorAnalysis || !colorRegionPixels) return;
  const pixels = colorAnalysis.w_px * colorAnalysis.h_px;
  const owners = new Int16Array((colorAnalysis.regions?.length || 0) + 1); owners.fill(-1);
  colorRegionOwners.clear(); colorMaskImages.clear(); colorMaskAlpha.clear();
  colorPalette.forEach((entry, index) => {
    const allowed = entry.region_seeds == null ? null : new Set(entry.region_seeds.map(seedKey));
    const excluded = new Set((entry.excluded_region_seeds || []).map(seedKey));
    (colorAnalysis.regions || []).forEach((region) => {
      if (region.color_id !== entry.source_color_id || (allowed && !allowed.has(seedKey(region.seed))) || excluded.has(seedKey(region.seed))) return;
      owners[region.code] = index; colorRegionOwners.set(region.code, entry.id);
    });
    entry.pixel_count = 0;
  });
  const buffers = colorPalette.map(() => new Uint8ClampedArray(pixels * 4));
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    const code = colorRegionPixels[offset] | (colorRegionPixels[offset + 1] << 8) | (colorRegionPixels[offset + 2] << 16);
    const owner = code ? owners[code] : -1;
    if (owner < 0) continue;
    const entry = colorPalette[owner], data = buffers[owner];
    data[offset] = entry.rgb[0]; data[offset + 1] = entry.rgb[1]; data[offset + 2] = entry.rgb[2]; data[offset + 3] = 255;
    entry.pixel_count++;
  }
  colorPalette.forEach((entry, index) => {
    const canvas = document.createElement('canvas'); canvas.width = colorAnalysis.w_px; canvas.height = colorAnalysis.h_px;
    canvas.getContext('2d').putImageData(new ImageData(buffers[index], canvas.width, canvas.height), 0, 0);
    entry.mask_png = canvas.toDataURL('image/png'); colorMaskImages.set(entry.id, canvas);
  });
  rebuildColorPrintPreview();
}

function updateColorLayerControls() {
  renderColorLayerHeights();
  $('#regionTools').hidden = !colorPalette.length;
  const active = colorActivePalette();
  if (!active.some(entry => entry.id === previewLayerId)) previewLayerId = active[0]?.id || null;
  if (!active.some(entry => entry.id === regionTargetId)) regionTargetId = active[0]?.id || null;
  for (const [selector, chosen] of [['#printLayerSelect', previewLayerId], ['#regionLayerSelect', regionTargetId]]) {
    const control = $(selector); control.innerHTML = '';
    active.forEach((entry) => { const option = document.createElement('option'); option.value = entry.id; option.textContent = colorLayerName(entry); control.appendChild(option); });
    control.value = chosen || '';
  }
  $('#printLayerSelect').hidden = colorPreviewMode !== 'print';
  $('#selectColorRegions').classList.toggle('is-active', regionSelecting);
  $('#colorCanvas').classList.toggle('is-selecting', regionSelecting);
  $('#splitColorRegions').disabled = !selectedColorRegions.size;
  const destination = $('#regionDestinationSelect'), previousDestination = destination.value;
  destination.innerHTML = '<option value="">New layer</option>';
  const source = colorPalette.find(entry => entry.id === regionTargetId);
  colorPalette.filter(entry => entry.id !== regionTargetId && entry.source_color_id === source?.source_color_id && !entry.ignored).forEach(entry => {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = colorLayerName(entry); destination.appendChild(option);
  });
  destination.value = [...destination.options].some(option => option.value === previousDestination) ? previousDestination : '';
  $('#splitLayerName').hidden = !!destination.value;
  $('#splitColorRegions').textContent = destination.value ? 'Move selected regions to layer' : 'Move selected regions to new layer';
  $('#regionSelectionInfo').textContent = regionSelecting
    ? `${selectedColorRegions.size} region(s) selected. Click separate regions in the selected layer; click again to deselect.`
    : 'Choose the source layer containing the region, then its destination. The destination can be an existing layer of the same colour.';
  rebuildColorPrintPreview();
}

function rebuildColorPrintPreview() {
  colorPrintPreview = null;
  if (!colorAnalysis) return;
  const active = colorActivePalette(), index = active.findIndex(entry => entry.id === previewLayerId);
  if (index < 0) return;
  const canvas = document.createElement('canvas'); canvas.width = colorAnalysis.w_px; canvas.height = colorAnalysis.h_px;
  const ctx = canvas.getContext('2d');
  active.slice(index).forEach(entry => { const image = colorMaskImages.get(entry.id); if (image) ctx.drawImage(image, 0, 0); });
  ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = active[index].hex; ctx.fillRect(0, 0, canvas.width, canvas.height);
  colorPrintPreview = canvas;
}

function rebuildColorSelectionOverlay() {
  if (!colorAnalysis || !colorRegionPixels) return;
  const canvas = document.createElement('canvas'); canvas.width = colorAnalysis.w_px; canvas.height = colorAnalysis.h_px;
  const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    const code = colorRegionPixels[offset] | (colorRegionPixels[offset + 1] << 8) | (colorRegionPixels[offset + 2] << 16);
    if (selectedColorRegions.has(code)) { data[offset] = 0; data[offset + 1] = 165; data[offset + 2] = 255; data[offset + 3] = 190; }
  }
  canvas.getContext('2d').putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0); colorSelectionOverlay = canvas;
}

function selectColorRegion(event) {
  if (colorHolePlacing || !regionSelecting || !colorRegionPixels || !colorAnalysis) return;
  const rect = colorCanvas.getBoundingClientRect();
  // Map CSS coordinates to canvas pixels, including browser zoom/layout scaling.
  const canvasX = (event.clientX - rect.left) * colorCanvas.width / rect.width;
  const canvasY = (event.clientY - rect.top) * colorCanvas.height / rect.height;
  const sourceX = (canvasX - colorView.ox) / colorView.zoom;
  const sourceY = (canvasY - colorView.oy) / colorView.zoom;
  const x = Math.floor(sourceX), y = Math.floor(sourceY);
  if (x < 0 || y < 0 || x >= colorAnalysis.w_px || y >= colorAnalysis.h_px) return;
  const offset = (y * colorAnalysis.w_px + x) * 4;
  let code = colorRegionPixels[offset] | (colorRegionPixels[offset + 1] << 8) | (colorRegionPixels[offset + 2] << 16);
  if (colorRegionOwners.get(code) !== regionTargetId) {
    // A tiny highlight can be just 2–3 screen pixels across. Find the closest
    // pixel of the requested source layer within an 8 CSS-pixel hit target.
    const sx = colorView.zoom * rect.width / colorCanvas.width;
    const sy = colorView.zoom * rect.height / colorCanvas.height;
    const rx = Math.ceil(8 / sx), ry = Math.ceil(8 / sy);
    let best = 64, nearest = 0;
    for (let yy = Math.max(0,y-ry); yy <= Math.min(colorAnalysis.h_px-1,y+ry); yy++) {
      for (let xx = Math.max(0,x-rx); xx <= Math.min(colorAnalysis.w_px-1,x+rx); xx++) {
        const distance = ((xx+0.5-sourceX)*sx)**2 + ((yy+0.5-sourceY)*sy)**2;
        if (distance >= best) continue;
        const p = (yy*colorAnalysis.w_px+xx)*4;
        const candidate = colorRegionPixels[p] | (colorRegionPixels[p+1]<<8) | (colorRegionPixels[p+2]<<16);
        if (colorRegionOwners.get(candidate) === regionTargetId) { best = distance; nearest = candidate; }
      }
    }
    code = nearest;
  }
  if (!code) { setColorStatus('Choose the source white layer, then click the highlight (small regions allow an 8 px margin).', 'err'); return; }
  if (selectedColorRegions.has(code)) selectedColorRegions.delete(code); else selectedColorRegions.add(code);
  rebuildColorSelectionOverlay(); updateColorLayerControls(); renderColorCanvas();
}

function splitColorRegions() {
  const source = colorPalette.find(entry => entry.id === regionTargetId);
  if (!source || !selectedColorRegions.size) return;
  const destination = colorPalette.find(entry => entry.id === $('#regionDestinationSelect').value && entry.id !== source.id && entry.source_color_id === source.source_color_id);
  if (!destination && colorPalette.length >= 24) { setColorStatus('This project already has 24 printable layers.', 'err'); return; }
  const seeds = colorAnalysis.regions.filter(region => selectedColorRegions.has(region.code) && colorRegionOwners.get(region.code) === source.id).map(region => region.seed);
  const selected = new Set(seeds.map(seedKey));
  if (source.region_seeds != null) source.region_seeds = source.region_seeds.filter(seed => !selected.has(seedKey(seed)));
  else source.excluded_region_seeds = [...(source.excluded_region_seeds || []), ...seeds];
  const layer = destination || { ...source, id: `${source.source_color_id}-split-${Date.now()}`, name: $('#splitLayerName').value.trim() || 'Highlights', region_seeds: seeds, excluded_region_seeds: [], ignored: false, visible: true };
  if (destination) {
    if (layer.region_seeds != null) layer.region_seeds = [...layer.region_seeds, ...seeds.filter(seed => !layer.region_seeds.some(existing => seedKey(existing) === seedKey(seed)))];
    else layer.excluded_region_seeds = (layer.excluded_region_seeds || []).filter(seed => !selected.has(seedKey(seed)));
  } else colorPalette.push(layer);
  selectedColorRegions.clear(); colorSelectionOverlay = null; regionSelecting = false;
  previewLayerId = layer.id;
  rebuildColorLayerMasks(); invalidateColorStl(); renderColorPalette(); renderColorLayers(); renderColorCanvas();
  setColorStatus(destination ? `Moved selected regions to ${colorLayerName(layer)}.` : `Created ${colorLayerName(layer)} at the top. Its colour is shared with the original layer.`, 'ok'); scheduleColorDraftPersist();
}

function chooseBackgroundCandidate() {
  backgroundCandidateId = colorAnalysis?.background_id || null;
}

function updateBackgroundTools() {
  const box = $('#backgroundTools');
  if (!box) return;
  const candidate = colorPalette.find((entry) => entry.id === backgroundCandidateId);
  box.hidden = !candidate;
  if (!candidate) return;
  const index = colorPalette.indexOf(candidate) + 1;
  $('#backgroundHint').textContent = colorBackgroundRemoved
    ? `Removed the exterior background of Color ${index}. Enclosed details are preserved.`
    : `Color ${index} is a likely flat background. Remove only its edge-connected regions.`;
  $('#removeBackgroundBtn').hidden = colorBackgroundRemoved;
  $('#restoreBackgroundBtn').hidden = !colorBackgroundRemoved;
}

async function setBackgroundRemoved(removed) {
  const candidate = colorPalette.find((entry) => entry.id === backgroundCandidateId);
  if (!candidate) return;
  if (removed === false && candidate.pixel_count === 0) { candidate.ignored = false; candidate.visible = true; }
  const previous = colorBackgroundRemoved;
  colorBackgroundRemoved = removed;
  $('#removeBackgroundBtn').disabled = true;
  $('#restoreBackgroundBtn').disabled = true;
  const success = await analyzeColorLayers({ preservePalette: true });
  if (!success) colorBackgroundRemoved = previous;
  updateBackgroundTools();
  $('#removeBackgroundBtn').disabled = false;
  $('#restoreBackgroundBtn').disabled = false;
}

function moveColorLayer(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= colorPalette.length) return;
  [colorPalette[index], colorPalette[next]] = [colorPalette[next], colorPalette[index]];
  invalidateColorStl();
  renderColorPalette(); renderColorLayers(); renderColorPlan(); renderColorCanvas();
  scheduleColorDraftPersist();
}

function renderColorLayers() {
  const panel = $('#colorLayerPanel');
  panel.innerHTML = '';
  colorPalette.forEach((entry, index) => {
    const row = el('div', 'layer-row' + (entry.ignored ? ' is-ignored' : ''));
    const thumb = document.createElement('img');
    thumb.className = 'layer-thumb'; thumb.src = entry.mask_png; thumb.alt = `Color ${index + 1} mask`;
    const name = el('span', 'layer-name');
    const swatch = el('span', 'layer-swatch'); swatch.style.background = entry.hex;
    const text = document.createElement('span'); text.textContent = `${colorLayerName(entry, index)}${entry.pixel_count === 0 ? ' · removed' : entry.ignored ? ' · ignored' : ''}`;
    name.append(swatch, text);
    const eye = el('button', 'layer-eye' + (!entry.ignored && (colorPreviewMode === 'print' ? entry.id === previewLayerId : entry.visible) ? ' is-on' : ''));
    eye.type = 'button'; eye.title = colorPreviewMode === 'print' ? `Inspect printed layer: ${colorLayerName(entry, index)}` : entry.visible ? 'Hide mask preview' : 'Show mask preview';
    eye.innerHTML = '<svg class="eye-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg><svg class="eye-ico eye-ico-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="1.8"/></svg>';
    eye.addEventListener('click', () => { if (colorPreviewMode === 'print') previewLayerId = entry.id; else entry.visible = !entry.visible; updateColorLayerControls(); renderColorLayers(); renderColorCanvas(); });
    row.append(thumb, name, eye);
    panel.appendChild(row);
  });
  renderColorPlan();
}

function colorsAlignToSlicer(value, layerHeight) {
  if (!(value > 0 && layerHeight > 0)) return false;
  return Math.abs(value / layerHeight - Math.round(value / layerHeight)) < 1e-6;
}

function colorLayerBands() {
  const { base, increment } = colorDimensionValues();
  let top = base;
  return colorActivePalette().map(entry => {
    const bottom = top, thickness = entry.height_mm == null ? increment : Number(entry.height_mm);
    top += thickness;
    return { entry, bottom, top, thickness };
  });
}

function renderColorLayerHeights() {
  const container = $('#colorLayerHeights');
  container.innerHTML = '';
  if (!colorActivePalette().length) { container.textContent = 'Upload an image to customize layer heights.'; return; }
  colorLayerBands().forEach(({ entry }, index) => {
    const row = el('div', 'field');
    const label = el('label', 'field-label');
    const id = `colorLayerHeight-${index}`;
    label.htmlFor = id;
    const name = document.createElement('span'); name.textContent = colorLayerName(entry);
    const value = el('span', 'field-value');
    const input = document.createElement('input');
    input.type = 'number'; input.id = id; input.min = '0.05'; input.max = '30'; input.step = '0.05';
    input.placeholder = $('#colorIncrement').value; input.value = entry.height_mm ?? '';
    input.addEventListener('input', () => {
      entry.height_mm = input.value === '' ? null : Number(input.value);
      invalidateColorStl(); renderColorPlan(); scheduleColorDraftPersist();
    });
    value.append(input, document.createTextNode(' mm')); label.append(name, value); row.append(label); container.append(row);
  });
}

function renderColorPlan() {
  const card = $('#colorPlanCard');
  const map = $('#colorHeightMap');
  const note = $('#colorPlanNote');
  const active = colorActivePalette();
  const { base, increment, slicer } = colorDimensionValues();
  card.hidden = !colorPalette.length;
  map.innerHTML = '';
  const bands = colorLayerBands();
  if (!active.length || !(base > 0 && increment > 0) || bands.some(band => !Number.isFinite(band.thickness) || band.thickness < 0.05 || band.thickness > 30)) {
    note.textContent = 'Enable a colour, use a positive base and increment, and set each layer height between 0.05 and 30 mm.';
    note.className = 'color-plan-note is-warning';
    return;
  }
  bands.forEach(({ entry, top, thickness }) => {
    const row = el('div', 'height-row');
    const swatch = el('span', 'height-swatch'); swatch.style.background = entry.hex;
    const text = document.createElement('span'); text.textContent = colorLayerName(entry, colorPalette.indexOf(entry));
    const height = document.createElement('b');
    const layerText = colorsAlignToSlicer(top, slicer) ? ` · before layer ${Math.round(top / slicer) + 1}` : '';
    height.textContent = `${thickness.toFixed(2)} mm · top Z ${top.toFixed(2)} mm${layerText}`;
    row.append(swatch, text, height); map.appendChild(row);
  });
  const aligned = colorsAlignToSlicer(base, slicer) && bands.every(band => colorsAlignToSlicer(band.thickness, slicer));
  note.className = 'color-plan-note' + (aligned ? '' : ' is-warning');
  const alignment = aligned
    ? `All heights align to ${slicer.toFixed(2)} mm slicer layers.`
    : `Warning: a height does not align cleanly with ${slicer.toFixed(2)} mm slicer layers; geometry is not rounded.`;
  // A general stepped colour height map cannot by itself produce arbitrary
  // multi-colour regions from global filament changes. State that plainly here
  // instead of promising an unsafe/incorrect swap sequence.
  note.textContent = `${alignment} Print each colour through its listed top Z, then change filament. Each slab includes all higher regions; the base uses the first colour. A colour can return at a later height. STL contains geometry only: configure filament changes in your slicer.`;
}

function updateColorMetrics() {
  if (!colorAnalysis) return;
  const width = Math.max(0, num($('#colorWidth')));
  const height = width * colorAnalysis.h_px / colorAnalysis.w_px;
  $('#colorHeightReadout').textContent = `Auto height: ${height.toFixed(1)} mm · aspect ratio locked`;
  const pixel = width / colorAnalysis.w_px;
  const feature = $('#colorFeatureNote');
  if (pixel < 0.4) {
    feature.textContent = `Printability note: one source pixel is ${pixel.toFixed(2)} mm; single-pixel features may be below a typical FDM nozzle width.`;
  } else {
    feature.textContent = `Image scale: 1 px = ${pixel.toFixed(2)} mm · height ${height.toFixed(1)} mm`;
  }
  renderColorPlan();
  renderColorCanvas();
}

function autoColorHole() {
  if (!colorAnalysis || !colorRegionPixels) { setColorStatus('Upload an illustration before placing a hole.', 'err'); return; }
  const activeIds = new Set(colorActivePalette().map(entry => entry.id));
  const w = colorAnalysis.w_px, h = colorAnalysis.h_px, scale = num($('#colorWidth')) / w;
  for (let y = 0; y < h; y++) {
    let sum = 0, count = 0;
    for (let x = 0; x < w; x++) {
      const p = (y*w+x)*4, code = colorRegionPixels[p] | (colorRegionPixels[p+1]<<8) | (colorRegionPixels[p+2]<<16);
      if (code && activeIds.has(colorRegionOwners.get(code))) { sum += x; count++; }
    }
    if (!count) continue;
    $('#colorHoleEnabled').checked = true;
    $('#colorHoleX').value = ((sum/count-w/2)*scale).toFixed(2);
    $('#colorHoleY').value = ((h/2-y)*scale+num($('#colorHoleDiameter'))/2+0.5).toFixed(2);
    colorHolePlacing = false; invalidateColorStl(); fitColorCanvas(); scheduleColorDraftPersist();
    setColorStatus('Base-only hole placed above the artwork; the relief remains intact.');
    return;
  }
}

function setupColorCanvas() {
  colorCanvas = $('#colorCanvas');
  colorCtx = colorCanvas.getContext('2d');
  colorCanvas.addEventListener('click', selectColorRegion);
  colorCanvas.addEventListener('click', event => {
    if (!colorHolePlacing || !colorAnalysis || !$('#colorHoleEnabled').checked) return;
    const rect = colorCanvas.getBoundingClientRect(), scale = num($('#colorWidth')) / colorAnalysis.w_px;
    const px = ((event.clientX-rect.left)*colorCanvas.width/rect.width-colorView.ox)/colorView.zoom;
    const py = ((event.clientY-rect.top)*colorCanvas.height/rect.height-colorView.oy)/colorView.zoom;
    $('#colorHoleX').value = ((px-colorAnalysis.w_px/2)*scale).toFixed(2);
    $('#colorHoleY').value = ((colorAnalysis.h_px/2-py)*scale).toFixed(2);
    colorHolePlacing = false; $('#colorHolePlace').classList.remove('is-active');
    invalidateColorStl(); fitColorCanvas(); scheduleColorDraftPersist();
  });
  $('#colorZoomFit').addEventListener('click', fitColorCanvas);
}

function fitColorCanvas() {
  if (!colorAnalysis || !colorCanvas) return;
  const wrap = $('#colorCanvasWrap');
  const width = Math.max(1, wrap.clientWidth), height = Math.max(1, wrap.clientHeight);
  colorCanvas.width = width; colorCanvas.height = height;
  let left = 0, top = 0, right = colorAnalysis.w_px, bottom = colorAnalysis.h_px;
  if ($('#colorHoleEnabled').checked && num($('#colorWidth')) > 0) {
    const mm = num($('#colorWidth')) / colorAnalysis.w_px, radius = (num($('#colorHoleDiameter'))/2+2)/mm;
    const x = num($('#colorHoleX'))/mm+colorAnalysis.w_px/2, y = colorAnalysis.h_px/2-num($('#colorHoleY'))/mm;
    left = Math.min(left,x-radius); top = Math.min(top,y-radius); right = Math.max(right,x+radius); bottom = Math.max(bottom,y+radius);
  }
  const scale = Math.min(width / (right-left), height / (bottom-top)) * 0.93;
  colorView.zoom = scale;
  colorView.ox = (width-(right-left)*scale)/2-left*scale;
  colorView.oy = (height-(bottom-top)*scale)/2-top*scale;
  renderColorCanvas();
}

function renderColorCanvas() {
  if (!colorCtx || !colorCanvas) return;
  colorCtx.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
  if (!colorAnalysis) return;
  // Draw from bottom to top. Masks are normally disjoint; this order also makes
  // any boundary overlap visibly match the user's chosen height order.
  if (colorPreviewMode === 'print' && colorPrintPreview) {
    colorCtx.drawImage(colorPrintPreview, colorView.ox, colorView.oy, colorAnalysis.w_px * colorView.zoom, colorAnalysis.h_px * colorView.zoom);
  } else colorPalette.forEach((entry) => {
    const image = colorMaskImages.get(entry.id);
    if (!entry.ignored && entry.visible && image) {
      colorCtx.drawImage(image, colorView.ox, colorView.oy, colorAnalysis.w_px * colorView.zoom, colorAnalysis.h_px * colorView.zoom);
    }
  });
  if (colorSelectionOverlay) colorCtx.drawImage(colorSelectionOverlay, colorView.ox, colorView.oy, colorAnalysis.w_px * colorView.zoom, colorAnalysis.h_px * colorView.zoom);
  if ($('#colorHoleEnabled').checked && num($('#colorWidth')) > 0) {
    const mm = num($('#colorWidth'))/colorAnalysis.w_px, radius = num($('#colorHoleDiameter'))/2/mm*colorView.zoom;
    const x = colorView.ox+(colorAnalysis.w_px/2+num($('#colorHoleX'))/mm)*colorView.zoom;
    const y = colorView.oy+(colorAnalysis.h_px/2-num($('#colorHoleY'))/mm)*colorView.zoom;
    colorCtx.save(); colorCtx.strokeStyle = '#e18a28'; colorCtx.lineWidth = 2; colorCtx.fillStyle = 'rgba(225,138,40,.18)';
    colorCtx.beginPath(); colorCtx.arc(x,y,radius+2/mm*colorView.zoom,0,Math.PI*2); colorCtx.fill(); colorCtx.stroke();
    colorCtx.beginPath(); colorCtx.arc(x,y,radius,0,Math.PI*2); colorCtx.stroke(); colorCtx.restore();
  }
  $('#colorPreviewHint').textContent = regionSelecting ? 'Click connected regions to select highlights' : colorPreviewMode === 'print' ? 'printed layer preview · includes every higher region' : 'surface regions · original colour assignment';
}

async function buildColorMaskAlpha() {
  if (!colorAnalysis) return;
  await Promise.all(colorPalette.map(async (entry) => {
    if (colorMaskAlpha.has(entry.id)) return;
    const image = colorMaskImages.get(entry.id) || await imageFromSource(entry.mask_png);
    const canvas = document.createElement('canvas');
    canvas.width = colorAnalysis.w_px; canvas.height = colorAnalysis.h_px;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    colorMaskAlpha.set(entry.id, context.getImageData(0, 0, canvas.width, canvas.height).data);
  }));
}

function initColorThree() {
  const canvas = $('#colorThreeCanvas');
  colorRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  colorRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  colorRenderer.outputColorSpace = THREE.SRGBColorSpace;
  colorRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  colorScene = new THREE.Scene();
  colorCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  colorControls = new OrbitControls(colorCamera, canvas);
  colorControls.enableDamping = true; colorControls.dampingFactor = 0.08;
  colorScene.add(new THREE.HemisphereLight(0xffffff, 0x2a2830, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(5, 7, 6); colorScene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-5, 2, -4); colorScene.add(fill);
  colorGrid = new THREE.GridHelper(8, 20, 0x3c3a49, 0x26252e); colorGrid.visible = false; colorScene.add(colorGrid);
  // STL thickness is Z: put the grid behind its XY backing, not through it.
  colorGrid.rotation.x = Math.PI / 2;
  colorModelGroup = new THREE.Group(); colorScene.add(colorModelGroup);
  const animateColor = () => { requestAnimationFrame(animateColor); colorControls.update(); colorRenderer.render(colorScene, colorCamera); };
  animateColor();
}

function resizeColorThree() {
  if (!colorRenderer) return;
  const viewport = $('#colorViewport');
  const width = viewport.clientWidth, height = viewport.clientHeight;
  if (!width || !height) return;
  colorRenderer.setSize(width, height);
  colorCamera.aspect = width / height;
  colorCamera.updateProjectionMatrix();
}

function fitColorCamera() {
  if (!colorModelGroup || !colorModelGroup.children.length) return;
  const sphere = new THREE.Box3().setFromObject(colorModelGroup).getBoundingSphere(new THREE.Sphere());
  const distance = sphere.radius * 2.7;
  colorCamera.position.set(distance * 1.2, distance * 0.55, distance * 0.9);
  colorCamera.near = distance / 100; colorCamera.far = distance * 100; colorCamera.updateProjectionMatrix();
  colorControls.target.copy(sphere.center); colorControls.update();
}

function sampledColorAt(xMm, yMm) {
  if (!colorAnalysis) return null;
  const widthMm = Math.max(1e-6, num($('#colorWidth')));
  const scale = widthMm / colorAnalysis.w_px;
  const x = Math.max(0, Math.min(colorAnalysis.w_px - 1, Math.round(xMm / scale + colorAnalysis.w_px / 2)));
  const y = Math.max(0, Math.min(colorAnalysis.h_px - 1, Math.round(colorAnalysis.h_px / 2 - yMm / scale)));
  // Prefer the highest listed visible region if contour smoothing caused a tiny
  // shared edge in the preview masks.
  for (let i = colorPalette.length - 1; i >= 0; i--) {
    const entry = colorPalette[i];
    if (entry.ignored) continue;
    const alpha = colorMaskAlpha.get(entry.id);
    if (alpha && alpha[(y * colorAnalysis.w_px + x) * 4 + 3] > 0) return entry;
  }
  return null;
}

async function loadColorStl(blob) {
  const loader = new STLLoader();
  const geometry = loader.parse(await blob.arrayBuffer());
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const center = new THREE.Vector3(); box.getCenter(center);
  const size = new THREE.Vector3(); box.getSize(size);
  const sceneScale = 3 / (Math.max(size.x, size.y, size.z) || 1);
  const position = geometry.getAttribute('position');
  const materialTriangles = new Map();
  const active = colorActivePalette();
  const { base, increment } = colorDimensionValues();
  const bands = colorLayerBands();
  active.forEach((entry) => materialTriangles.set(entry.id, []));
  const clip = (vertices, z, above) => {
    const output = [];
    vertices.forEach((b, index) => {
      const a = vertices[(index + vertices.length - 1) % vertices.length];
      const ain = above ? a[2] >= z : a[2] <= z;
      const bin = above ? b[2] >= z : b[2] <= z;
      if (ain !== bin) { const t = (z - a[2]) / (b[2] - a[2]); output.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), z]); }
      if (bin) output.push(b);
    });
    return output;
  };
  const append = (vertices, target) => {
    for (let k = 1; k + 1 < vertices.length; k++) {
      const a = vertices[0], b = vertices[k], c = vertices[k + 1];
      const u = b.map((v, j) => v - a[j]), v = c.map((value, j) => value - a[j]);
      if (Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]) < 1e-12) continue;
      for (const point of [a,b,c]) target.push((point[0]-center.x)*sceneScale, (point[1]-center.y)*sceneScale, (point[2]-center.z)*sceneScale);
    }
  };
  for (let i = 0; i < position.count; i += 3) {
    const triangle = [0,1,2].map(k => [position.getX(i+k),position.getY(i+k),position.getZ(i+k)]);
    const low = Math.min(...triangle.map(p => p[2])), high = Math.max(...triangle.map(p => p[2]));
    if (high-low < 1e-6) {
      const match = bands.findIndex(band => high <= band.top + 1e-6);
      const index = match < 0 ? active.length - 1 : match;
      append(triangle, materialTriangles.get(active[index].id));
    } else active.forEach((entry, index) => {
      const bottom = index === 0 ? box.min.z : bands[index].bottom;
      const top = index === active.length-1 ? Math.max(box.max.z,bands[index].top) : bands[index].top;
      if (high <= bottom || low >= top) return;
      append(clip(clip(triangle,bottom,true),top,false),materialTriangles.get(entry.id));
    });
  }
  while (colorModelGroup.children.length) { const part = colorModelGroup.children[0]; part.geometry.dispose(); part.material.dispose(); colorModelGroup.remove(part); }
  const addPart = (triangles, color) => {
    if (!triangles.length) return;
    const part = new THREE.Mesh(makePartGeometry(triangles), new THREE.MeshStandardMaterial({ color, roughness: 0.52, metalness: 0.04, flatShading: true }));
    colorModelGroup.add(part);
  };
  active.forEach(entry => addPart(materialTriangles.get(entry.id), entry.hex));
  geometry.dispose();
  colorGrid.visible = true;
  colorGrid.position.set(0, 0, (box.min.z - center.z) * sceneScale - 0.05);
  resizeColorThree(); fitColorCamera();
  $('#colorVpEmpty').hidden = true;
  $('#colorResetView').hidden = false;
  $('#colorVpInfo').hidden = false;
  $('#colorVpInfo').innerHTML = `base <b>${base.toFixed(2)}</b> mm · top Z <b>${bands.at(-1).top.toFixed(2)}</b> mm · <b>${active.length}</b> printable layers`;
}

async function generateColorLayers() {
  if (!colorSourceFile || !colorAnalysis) { setColorStatus('Analyze a colour illustration before generating.', 'err'); return; }
  if (!colorActivePalette().length) { setColorStatus('Enable at least one colour layer before generating.', 'err'); return; }
  const { width, base, increment } = colorDimensionValues();
  if (!(width > 0 && base > 0 && increment > 0)) { setColorStatus('Width, base thickness, and increment must be greater than zero.', 'err'); return; }
  if (colorLayerBands().some(band => !Number.isFinite(band.thickness) || band.thickness < 0.05 || band.thickness > 30)) { setColorStatus('Each layer height must be between 0.05 and 30 mm.', 'err'); return; }
  const fd = new FormData();
  fd.append('file', colorSourceFile, colorSourceName || 'illustration.png');
  fd.append('width', String(width));
  fd.append('base', String(base));
  fd.append('increment', String(increment));
  fd.append('alpha_threshold', '8');
  fd.append('cleanup_min_area', String(Math.max(0, int($('#colorCleanup')))));
  fd.append('palette', JSON.stringify(colorAnalysis.palette));
  fd.append('layers', JSON.stringify(serializablePalette()));
  if ($('#colorHoleEnabled').checked) fd.append('base_hole', JSON.stringify({ x: num($('#colorHoleX')), y: num($('#colorHoleY')), diameter: num($('#colorHoleDiameter')), height: $('#colorHoleHeight').value === '' ? base : num($('#colorHoleHeight')) }));
  fd.append('remove_background', String(colorBackgroundRemoved));
  const button = $('#colorGenerateBtn'); button.disabled = true;
  setColorStatus('Tracing masks, extruding ordered relief, and combining the STL…');
  try {
    const response = await fetch('/api/color/generate', { method: 'POST', body: fd });
    if (!response.ok) {
      let message = 'Color STL generation failed.';
      try { const body = await response.json(); message = body.error || body.detail || message; } catch (_) { /* non-JSON fallback */ }
      throw new Error(message);
    }
    colorStlBlob = await response.blob();
    await loadColorStl(colorStlBlob);
    $('#colorDownloadBtn').disabled = false;
    setColorStatus(`Color STL ready · ${fmtSize(colorStlBlob.size)}`, 'ok');
  } catch (error) {
    setColorStatus(error.message || 'Color STL generation failed.', 'err');
  } finally {
    button.disabled = false;
  }
}

function downloadColorStl() {
  if (!colorStlBlob) return;
  const base = (colorSourceName || 'color-layer-relief').replace(/\.[^.]+$/, '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(colorStlBlob); link.download = `${base}-color-layer.stl`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

function setupColorDropzone() {
  const zone = $('#colorDropzone'); const input = $('#colorFileInput');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
  ['dragover', 'dragenter'].forEach(type => zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(type => zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (event) => { const file = event.dataTransfer.files && event.dataTransfer.files[0]; if (file) setColorSource(file, file.name); });
  input.addEventListener('change', () => { if (input.files && input.files[0]) setColorSource(input.files[0], input.files[0].name); });
}

function initColorLayerMode() {
  initColorThree(); setupColorCanvas(); setupColorDropzone();
  $('#lineModeTab').addEventListener('click', () => setWorkbenchMode('line'));
  $('#colorModeTab').addEventListener('click', () => setWorkbenchMode('color'));
  $('#colorAnalyzeBtn').addEventListener('click', analyzeColorLayers);
  $('#removeBackgroundBtn').addEventListener('click', () => setBackgroundRemoved(true));
  $('#restoreBackgroundBtn').addEventListener('click', () => setBackgroundRemoved(false));
  $('#colorGenerateBtn').addEventListener('click', generateColorLayers);
  $('#colorDownloadBtn').addEventListener('click', downloadColorStl);
  $('#colorResetView').addEventListener('click', fitColorCamera);
  $('#colorHoleAuto').addEventListener('click', autoColorHole);
  $('#colorHoleEnabled').addEventListener('change', () => { colorHolePlacing = false; if ($('#colorHoleEnabled').checked && num($('#colorHoleX')) === 0 && num($('#colorHoleY')) === 0) autoColorHole(); invalidateColorStl(); fitColorCanvas(); scheduleColorDraftPersist(); });
  ['#colorHoleDiameter','#colorHoleHeight','#colorHoleX','#colorHoleY'].forEach(selector => $(selector).addEventListener('input', () => { invalidateColorStl(); fitColorCanvas(); scheduleColorDraftPersist(); }));
  $('#colorHolePlace').addEventListener('click', () => { if (!colorAnalysis) return; $('#colorHoleEnabled').checked = true; regionSelecting = false; colorHolePlacing = !colorHolePlacing; $('#colorHolePlace').classList.toggle('is-active',colorHolePlacing); updateColorLayerControls(); setColorStatus(colorHolePlacing ? 'Click the preview to position the base-only hole. The tab must touch the artwork.' : 'Hole positioning stopped.'); });
  ['#colorWidth', '#colorBase', '#colorIncrement'].forEach((selector) => $(selector).addEventListener('input', () => { invalidateColorStl(); updateColorMetrics(); renderColorLayerHeights(); }));
  $('#colorResetHeights').addEventListener('click', () => { colorPalette.forEach(entry => { entry.height_mm = null; }); invalidateColorStl(); renderColorLayerHeights(); renderColorPlan(); scheduleColorDraftPersist(); });
  $('#colorSlicerLayer').addEventListener('input', updateColorMetrics);
  $('#colorCleanup').addEventListener('change', () => { if (colorSourceFile) analyzeColorLayers(); });
  $('#colorPaletteSize').addEventListener('change', () => { savedColorPalette = null; if (colorSourceFile) analyzeColorLayers({ resetLayers: true }); });
  $('#colorPreviewMode').addEventListener('change', (e) => { colorPreviewMode = e.target.value; regionSelecting = false; updateColorLayerControls(); renderColorLayers(); renderColorCanvas(); });
  $('#printLayerSelect').addEventListener('change', (e) => { previewLayerId = e.target.value; updateColorLayerControls(); renderColorLayers(); renderColorCanvas(); });
  $('#regionLayerSelect').addEventListener('change', (e) => { regionTargetId = e.target.value; selectedColorRegions.clear(); if (regionSelecting) { const source = colorPalette.find(entry => entry.id === regionTargetId); if (source) source.visible = true; } rebuildColorSelectionOverlay(); updateColorLayerControls(); renderColorLayers(); renderColorCanvas(); });
  $('#selectColorRegions').addEventListener('click', () => { regionSelecting = !regionSelecting; if (regionSelecting) { colorPreviewMode = 'regions'; $('#colorPreviewMode').value = 'regions'; const source = colorPalette.find(entry => entry.id === regionTargetId); if (source) source.visible = true; } updateColorLayerControls(); renderColorLayers(); renderColorCanvas(); });
  $('#splitColorRegions').addEventListener('click', splitColorRegions);
  $('#regionDestinationSelect').addEventListener('change', () => updateColorLayerControls());
  $('#clearColorRegions').addEventListener('click', () => { selectedColorRegions.clear(); rebuildColorSelectionOverlay(); updateColorLayerControls(); renderColorCanvas(); });
  window.addEventListener('resize', () => { resizeColorThree(); if (colorAnalysis && activeMode === 'color') fitColorCanvas(); });
}

function colorSettings() {
  return {
    paletteSize: $('#colorPaletteSize').value, width: $('#colorWidth').value, base: $('#colorBase').value,
    increment: $('#colorIncrement').value, cleanup: $('#colorCleanup').value, slicerLayer: $('#colorSlicerLayer').value,
    removeBackground: colorBackgroundRemoved,
    holeEnabled: $('#colorHoleEnabled').checked, holeDiameter: $('#colorHoleDiameter').value,
    holeHeight: $('#colorHoleHeight').value,
    holeX: $('#colorHoleX').value, holeY: $('#colorHoleY').value,
  };
}

function serializablePalette() {
  return colorPalette.map(({ id, rgb, lab, hex, ignored, visible, name, source_color_id, region_seeds, excluded_region_seeds, height_mm }) => ({ id, rgb, lab, hex, ignored, visible, name, source_color_id, region_seeds, excluded_region_seeds, height_mm }));
}

function applySavedColorPalette() {
  if (!savedColorPalette || !savedColorPalette.length) return;
  const sources = colorPalette.slice();
  const regions = new Map((colorAnalysis.regions || []).map(region => [region.code, region]));
  // Boundary correction may move a saved seed by a few pixels. Re-anchor it
  // to the same pigment's nearest component, not to an unrelated height group.
  const anchor = (seed, sourceId) => {
    if (!colorRegionPixels || !Array.isArray(seed)) return seed;
    const [x,y] = seed, w = colorAnalysis.w_px, h = colorAnalysis.h_px;
    let best = Infinity, match = null;
    for (let yy = Math.max(0,y-4); yy <= Math.min(h-1,y+4); yy++) for (let xx = Math.max(0,x-4); xx <= Math.min(w-1,x+4); xx++) {
      const distance = (xx-x)**2 + (yy-y)**2;
      if (distance >= best) continue;
      const offset = (yy*w+xx)*4;
      const code = colorRegionPixels[offset] | (colorRegionPixels[offset+1]<<8) | (colorRegionPixels[offset+2]<<16);
      const region = regions.get(code);
      if (region?.color_id === sourceId) { best = distance; match = region.seed; }
    }
    return match || seed;
  };
  const anchors = (seeds, sourceId) => seeds == null ? null : [...new Map(seeds.map(seed => { const updated = anchor(seed, sourceId); return [seedKey(updated), updated]; })).values()];
  const ordered = [];
  savedColorPalette.forEach((saved) => {
    const match = sources.find(entry => entry.id === (saved.source_color_id || saved.id)) || sources.find(entry => entry.hex === saved.hex);
    if (match) ordered.push({ ...match, id: saved.id, source_color_id: match.id, name: saved.name, height_mm: saved.height_mm ?? null, region_seeds: anchors(saved.region_seeds, match.id), excluded_region_seeds: anchors(saved.excluded_region_seeds || [], match.id), ignored: Boolean(saved.ignored), visible: saved.visible !== false });
  });
  sources.forEach((entry) => { if (!ordered.some(group => group.source_color_id === entry.id)) ordered.push(entry); });
  colorPalette = ordered;
}



const COLOR_DRAFT_KEY = 'drafterflow_color_draft_v1';
let savedColorPalette = null, colorSourceDataUrl = null;
let isRestoringColorDraft = false, colorDraftTimer = null;
function rememberColorSource(file) {
  const reader = new FileReader();
  reader.onload = () => {
    if (colorSourceFile !== file) return;
    colorSourceDataUrl = reader.result; scheduleColorDraftPersist();
  };
  reader.readAsDataURL(file);
}
function scheduleColorDraftPersist() {
  if (isRestoringColorDraft) return;
  clearTimeout(colorDraftTimer); colorDraftTimer = setTimeout(persistColorDraft, 700);
}
function persistColorDraft() {
  if (isRestoringColorDraft || !colorSourceDataUrl) return;
  try {
    localStorage.setItem(COLOR_DRAFT_KEY, JSON.stringify({sourceDataUrl:colorSourceDataUrl, sourceName:colorSourceName, settings:colorSettings(), palette:serializablePalette(), mode:activeMode}));
  } catch (_) { /* Large sources may exceed browser storage; editor still works. */ }
}
async function restoreColorDraft() {
  const raw = localStorage.getItem(COLOR_DRAFT_KEY);
  if (!raw) return;
  isRestoringColorDraft = true;
  try {
    const draft = JSON.parse(raw);
    if (!draft.sourceDataUrl) return;
    const settings = draft.settings || {};
    const mapping = {paletteSize:'#colorPaletteSize', width:'#colorWidth', base:'#colorBase', increment:'#colorIncrement', cleanup:'#colorCleanup', slicerLayer:'#colorSlicerLayer', holeDiameter:'#colorHoleDiameter', holeX:'#colorHoleX', holeY:'#colorHoleY'};
    Object.entries(mapping).forEach(([key, selector]) => { if (settings[key] != null) $(selector).value = settings[key]; });
    $('#colorHoleEnabled').checked = settings.holeEnabled === true;
    $('#colorHoleHeight').value = settings.holeHeight ?? '';
    savedColorPalette = draft.palette || null; colorSourceDataUrl = draft.sourceDataUrl;
    const blob = await (await fetch(draft.sourceDataUrl)).blob();
    await setColorSource(new File([blob], draft.sourceName || 'illustration.png', {type:blob.type}), draft.sourceName, {removeBackground:settings.removeBackground === true});
    setWorkbenchMode(draft.mode === 'color' ? 'color' : 'line');
  } catch (_) { /* A malformed local draft must never prevent editor startup. */ }
  finally { isRestoringColorDraft = false; }
}

function init() {
  initThree();
  setupDropzone();
  loadExamples();
  initHero();
  initGallery();
  initTheme();
  initLanguage();
  initColorLayerMode();
  document.querySelector('#colorWorkbench').addEventListener('input', scheduleColorDraftPersist);
  document.querySelector('#colorWorkbench').addEventListener('change', scheduleColorDraftPersist);
  window.addEventListener('beforeunload', persistColorDraft);
  restoreColorDraft();

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
  $('#holeReset').addEventListener('click', resetInvalidHoles);
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey, tg = e.target && e.target.tagName;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redoHoles() : undoHoles(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoHoles(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && activeTool === 'select' && tg !== 'INPUT') deleteSelectedHole();
  });
  window.addEventListener('resize', () => { syncOrigThumb(); if (analysis) fitCanvas(); });

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
