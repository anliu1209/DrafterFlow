const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; };
export const icons = {
  layers: '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  geometry: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10L3 7m9 5 9-5m-9 5v10"/>',
  keychain: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  hidden: '<path d="m3 3 18 18M9 5a12 12 0 0 1 3 0c7 0 10 7 10 7a17 17 0 0 1-4 5M6 6a19 19 0 0 0-4 6s3 7 10 7c2 0 3-1 5-2"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  export: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  undo: '<path d="m9 4-6 6 6 6M3 10h11a7 7 0 0 1 7 7"/>',
  redo: '<path d="m15 4 6 6-6 6M21 10H10a7 7 0 0 0-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
export const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.layers}</svg>`;
const iconButton = (icon, label, action) => {
  const button = node('button', 'ws-icon'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.innerHTML = svg(icon); button.addEventListener('click', action); return button;
};

// Display and model order both run bottom-to-top (first printed layer first).
export function renderLayerList(root, state, actions) {
  root.replaceChildren();
  if (!state.layers.length) {
    root.append(node('div', 'ws-layer-empty', 'Your physical layers will appear here after analysis.')); return;
  }
  const heights = new Map(state.bands.map(band => [band.entry.id, band]));
  state.layers.forEach((entry) => {
    const index = state.layers.indexOf(entry), band = heights.get(entry.id), name = entry.name || `Layer ${index + 1}`;
    const row = node('div', 'ws-layer' + (entry.id === state.selectedId ? ' is-selected' : '') + (entry.ignored ? ' is-excluded' : ''));
    row.dataset.layerId = entry.id; row.tabIndex = 0; row.setAttribute('role', 'listitem'); row.setAttribute('aria-label', `${name}, physical layer ${index + 1}${entry.ignored ? ', excluded' : ''}`);
    if (entry.id === state.selectedId) row.setAttribute('aria-current', 'true');
    let pointerDrag = null, suppressClick = false;
    const handle = iconButton('grip', `Drag ${name} to reorder`, () => { if (suppressClick) { suppressClick = false; return; } actions.select(entry.id); });
    handle.classList.add('ws-drag-handle'); handle.draggable = false; handle.disabled = state.analyzing;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || state.analyzing) return;
      pointerDrag = {id:event.pointerId,x:event.clientX,y:event.clientY,moved:false}; handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
      if (Math.hypot(event.clientX-pointerDrag.x,event.clientY-pointerDrag.y) > 5) pointerDrag.moved = true;
      if (!pointerDrag.moved) return;
      row.classList.add('is-dragging');
      root.querySelectorAll('.is-drop-target').forEach(n=>n.classList.remove('is-drop-target'));
      const target = document.elementFromPoint(event.clientX,event.clientY)?.closest('.ws-layer');
      if (target && target !== row && root.contains(target)) target.classList.add('is-drop-target');
      const rect=root.getBoundingClientRect();
      if(event.clientY>rect.bottom-18)root.scrollTop+=10;
      if(event.clientY<rect.top+18)root.scrollTop-=10;
    });
    handle.addEventListener('pointerup', event => {
      if (!pointerDrag) return;
      const moved=pointerDrag.moved; pointerDrag=null;
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      root.querySelectorAll('.is-drop-target,.is-dragging').forEach(n=>n.classList.remove('is-drop-target','is-dragging'));
      if(moved) { suppressClick=true; const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.ws-layer'); if(target&&target!==row&&root.contains(target))actions.reorder(entry.id,target.dataset.layerId); }
    });
    handle.addEventListener('pointercancel', ()=>{pointerDrag=null;row.classList.remove('is-dragging');});
    // Also accept native HTML drag data for integrations/accessibility tooling.
    handle.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-drafterflow-layer', entry.id); event.dataTransfer.effectAllowed = 'move'; row.classList.add('is-dragging'); });
    handle.addEventListener('dragend', () => root.querySelectorAll('.is-drop-target,.is-dragging').forEach(n => n.classList.remove('is-drop-target','is-dragging')));
    row.addEventListener('dragover', event => { if (!event.dataTransfer.types.includes('application/x-drafterflow-layer')) return; event.preventDefault(); row.classList.add('is-drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', event => { event.preventDefault(); const from = event.dataTransfer.getData('application/x-drafterflow-layer'); row.classList.remove('is-drop-target'); if (from && from !== entry.id) actions.reorder(from, entry.id); });
    const swatch = node('span', 'ws-swatch'); swatch.style.background = entry.hex;
    const nameButton = node('button', 'ws-layer-name', name);
    nameButton.type = 'button'; nameButton.title = `Rename ${name}`;
    nameButton.setAttribute('aria-label', `Rename ${name}`);
    nameButton.disabled = state.analyzing;
    nameButton.addEventListener('click', () => actions.renameStart(entry.id));
    const title = node('div', 'ws-layer-copy'); title.append(nameButton, node('span', '', band ? `Layer ${index + 1} · +${band.thickness.toFixed(2)} mm` : entry.pixel_count ? 'Excluded from model' : 'No regions remaining'));
    const eye = iconButton(entry.visible ? 'eye' : 'hidden', `${entry.visible ? 'Hide' : 'Show'} ${name} regions`, () => actions.visibility(entry.id));
    eye.setAttribute('aria-pressed', String(entry.visible));
    eye.disabled = state.analyzing;
    const order = node('div', 'ws-layer-order');
    const lower = iconButton('up', `Move ${name} lower`, () => actions.move(index, -1)); lower.disabled = state.analyzing || index === 0;
    const higher = iconButton('down', `Move ${name} higher`, () => actions.move(index, 1)); higher.disabled = state.analyzing || index === state.layers.length - 1;
    order.append(lower, higher);
    const choose = () => { if (!state.analyzing) actions.select(entry.id); };
    row.addEventListener('click', event => { if (!event.target.closest('button,input')) choose(); });
    row.addEventListener('keydown', event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose(); } });
    row.append(handle, swatch, title, eye, order); root.append(row);
  });
}

export function syncLayerInspector(root, state) {
  const entry = state.layers.find(layer => layer.id === state.selectedId);
  root.hidden = !entry;
  if (!entry) return;
  const band = state.bands.find(b => b.entry.id === entry.id);
  const name = root.querySelector('#workspaceLayerName'), height = root.querySelector('#workspaceLayerHeight');
  if (document.activeElement !== name) name.value = entry.name || `Layer ${state.layers.indexOf(entry) + 1}`;
  if (document.activeElement !== height) height.value = entry.height_mm ?? '';
  name.disabled = state.analyzing;
  height.placeholder = state.increment; height.disabled = entry.ignored || state.analyzing;
  root.querySelector('#workspaceLayerTop').textContent = band ? `Top surface: ${band.top.toFixed(2)} mm` : 'Excluded from generated geometry';
  root.querySelector('#workspaceRegionCount').textContent = `${state.regionCount} connected region${state.regionCount === 1 ? '' : 's'}`;
  const include = root.querySelector('#workspaceIncludeLayer'); include.checked = !entry.ignored; include.disabled = !entry.pixel_count || state.analyzing;
  root.querySelector('#workspaceLayerSwatch').style.background = entry.hex;
}
