import { renderLayerList, syncLayerInspector, svg } from './layers-panel.js?v=layer-names-1';

const $ = selector => document.querySelector(selector);
const move = (selector, target) => { const element = typeof selector === 'string' ? $(selector) : selector; if (element) $(target).append(element); return element; };

// Presentation adapter only: all masks, seeds, height bands, API calls and saved
// projects continue to belong to app.js. Existing controls are moved, not cloned.
export function createWorkspace(adapter) {
  const root = $('#editorWorkspace');
  root.innerHTML = `
    <aside class="ws-tools" aria-label="Artwork and fabrication tools">
      <div class="ws-panel-heading"><span class="ws-kicker">WORKSPACE</span><button class="ws-icon ws-drawer-close" data-close-sidebar aria-label="Close tools">${svg('close')}</button></div>
      <nav class="ws-tool-nav" aria-label="Tool categories">
        <button type="button" data-tool-panel="artwork" aria-pressed="true">${svg('image')}Artwork</button>
        <button type="button" data-tool-panel="geometry" aria-pressed="false">${svg('geometry')}Geometry</button>
        <button type="button" data-tool-panel="keychain" aria-pressed="false">${svg('keychain')}Keychain</button>
      </nav>
      <div class="ws-tools-scroll">
        <section data-tools="artwork">
          <div class="ws-file-summary" id="workspaceFileSummary" hidden><img id="workspaceFileThumb" alt="Uploaded artwork"><div><strong id="workspaceFileName"></strong><span id="workspaceAnalysisSummary"></span></div></div>
          <div id="workspaceColorArtwork" data-engine="color"></div>
          <div id="workspaceLineArtwork" data-engine="line" hidden></div>
          <section class="ws-section" id="workspaceAnalysis"><h3>Analysis</h3><div id="workspaceColorAnalysis" data-engine="color"></div><div data-engine="line" hidden><div class="ws-analysis-row"><span>Target colors</span><strong>2</strong></div><button type="button" id="workspaceStrokeAnalyze" class="btn btn-ghost">Analyze Image</button></div><p class="ws-help">Colors identify regions. Layers decide what gets printed above what.</p></section>
          <details class="ws-processing"><summary>Processing options</summary><label for="workspaceProcessor">Image processing</label><select id="workspaceProcessor"><option value="color">Layered image</option><option value="line">Stroke extraction</option></select><p class="ws-help">Stroke extraction retains the original outline, threshold and multi-hole tools for older drawings.</p></details>
        </section>
        <section data-tools="geometry" hidden><div id="workspaceColorGeometry" data-engine="color"></div><div id="workspaceLineGeometry" data-engine="line" hidden></div></section>
        <section data-tools="keychain" hidden><div id="workspaceColorKeychain" data-engine="color"></div><div id="workspaceLineKeychain" data-engine="line" hidden></div><button type="button" id="workspaceCancelPlacement" class="btn btn-ghost" hidden>Cancel placement</button></section>
      </div>
      <div class="ws-tool-summary"><span>Artwork size</span><strong id="workspaceSizeSummary">No artwork yet</strong><span id="workspaceGeometrySummary">Set dimensions in Geometry</span></div>
    </aside>
    <section class="ws-canvas" aria-label="Artwork canvas and model previews">
      <div class="ws-preview-header"><button class="ws-icon ws-mobile-toggle" id="workspaceOpenTools" title="Open tools" aria-label="Open tools">${svg('geometry')}</button><div class="ws-preview-tabs" role="tablist" aria-label="Preview views">${[['artwork','Artwork'],['regions','Regions'],['print','Print Plan'],['3d','3D']].map(([key,label]) => `<button type="button" role="tab" id="workspaceTab-${key}" data-preview="${key}" aria-selected="${key === 'artwork'}" aria-controls="workspacePreview">${label}</button>`).join('')}</div><button class="ws-icon ws-mobile-toggle" id="workspaceOpenLayers" title="Open layers" aria-label="Open layers">${svg('layers')}</button></div>
      <div class="ws-preview-options"><div id="workspaceArtworkOptions"><button type="button" data-artwork-version="original" aria-pressed="true">Original</button><button type="button" data-artwork-version="processed" aria-pressed="false">Processed</button></div><div id="workspacePrintOptions" hidden><label for="printLayerSelect">Printing</label></div><div id="workspaceRegionOptions" hidden><span>Select a layer, then choose regions</span><button type="button" id="workspaceCanvasSelect" class="ws-text-button">Select regions</button></div><span id="workspaceViewHelp">Your image is the canvas.</span></div>
      <div class="ws-preview-stack" id="workspacePreview" role="tabpanel" aria-labelledby="workspaceTab-artwork">
        <div class="ws-artwork checker" id="workspaceArtworkViewport"><img id="workspaceArtworkImage" alt="Original artwork" draggable="false"></div>
        <div class="ws-empty" id="workspaceEmpty"><div class="ws-empty-art" aria-hidden="true"><span></span><span></span><span></span>${svg('image')}</div><span class="ws-kicker">THE IMAGE IS THE CANVAS.</span><h2>Make something<br>you can hold.</h2><p>A drawing, illustration or logo.<br>We’ll turn its regions into physical layers.</p><button type="button" id="workspaceUpload" class="btn btn-primary">${svg('upload')}Upload Image</button><span class="ws-help">or drop an image here · PNG / JPG / WEBP</span><button type="button" id="workspaceExample" class="ws-text-button">Try a two-color drawing</button></div>
        <div class="ws-stale" id="workspaceStale" hidden><span>Model has changes.</span><button type="button" id="workspaceStaleUpdate" class="ws-text-button">Update Model</button></div>
        <div class="ws-generation-progress" id="workspaceGenerationProgress" hidden aria-live="polite"><span class="ws-spinner" aria-hidden="true"></span><div><strong>Generating model</strong><p id="workspaceGenerationPhase"></p></div></div>
        <div class="ws-generation-progress ws-generation-error" id="workspaceGenerationError" hidden role="alert"></div>
        <div class="ws-tool-message" id="workspaceToolMessage" hidden><span id="workspaceToolMessageText"></span><button type="button" id="workspaceCancelTool" class="ws-text-button">Cancel</button></div>
      </div>
      <div class="ws-canvas-footer"><span id="workspaceCanvasMeta">No image selected</span><div id="workspaceColorPreviewToolbar" data-engine="color"></div><div id="workspaceLinePreviewToolbar" data-engine="line" hidden></div></div>
      <details class="ws-print-notes" id="workspacePrintNotes" hidden><summary>Print heights &amp; filament changes</summary><div id="workspacePrintPlan"></div><div id="workspaceLinePrintPlan" data-engine="line" hidden></div></details>
      <div class="ws-status-bar" role="status" aria-live="polite"><span class="ws-status-dot"></span><span id="workspaceStatus">Ready when you are.</span><span id="workspaceModelState">No model yet</span></div>
    </section>
    <aside class="ws-layers" aria-label="Layers and inspector">
      <div class="ws-panel-heading"><div><h2>Layers <span id="workspaceLayerCount">0</span></h2><p>The layers are the model.</p></div><button class="ws-icon ws-drawer-close" data-close-sidebar aria-label="Close layers">${svg('close')}</button></div>
      <div class="ws-stack-label"><span>BOTTOM · first printed</span>${svg('down')}</div>
      <div class="ws-layer-list" id="workspaceLayerList" role="list" aria-label="Physical layers, bottom to top" data-engine="color"></div><div id="workspaceLegacyLayers" data-engine="line" hidden></div>
      <div class="ws-stack-label ws-stack-bottom"><span>TOP · last printed</span><span id="workspaceStackHeight">0 mm</span></div>
      <div class="ws-inspector-scroll">
        <section class="ws-inspector" id="workspaceLayerInspector" data-engine="color" hidden><div class="ws-inspector-title"><h3>Layer settings</h3><span id="workspaceLayerSwatch" class="ws-swatch"></span></div><label for="workspaceLayerName">Name</label><input id="workspaceLayerName" maxlength="80" autocomplete="off"><label class="ws-number-label" for="workspaceLayerHeight"><span>Height added</span><span class="ws-number"><input id="workspaceLayerHeight" type="number" min="0.05" max="30" step="0.05" aria-describedby="workspaceHeightHelp">mm</span></label><p class="ws-help" id="workspaceHeightHelp">Added thickness, not absolute Z. Blank uses the default.</p><div class="ws-inspector-meta"><span id="workspaceLayerTop"></span><span id="workspaceRegionCount"></span></div><label class="ws-check"><input id="workspaceIncludeLayer" type="checkbox">Include in model</label></section>
        <section class="ws-region-inspector" id="workspaceRegionInspector" data-engine="color"><div class="ws-inspector-title"><h3>Regions</h3><span id="workspaceSelectedCount">0 selected</span></div><div id="workspaceRegionTools"></div><p class="ws-help" id="workspaceRegionEmpty">Select a layer to edit its connected regions.</p></section>
        <div id="workspaceLegacyInspector" data-engine="line" hidden></div>
        <p class="ws-filament-note">Preview colors identify layers.<br>Your filament sets the physical color.</p>
      </div>
    </aside><button class="ws-drawer-backdrop" id="workspaceCloseDrawers" aria-label="Close sidebar" hidden></button>
    <div id="workspaceInternals" hidden></div>`;

  $('#workspaceExample').textContent = 'Try the chef example';
  // AppHeader: one persistent primary action, secondary export and existing hole history.
  const header = document.createElement('div'); header.id = 'workspaceHeaderActions'; header.className = 'ws-header-actions';
  header.innerHTML = `<button type="button" class="ws-icon" id="workspaceUndo" aria-label="Undo hole edit" title="Undo hole edit">${svg('undo')}</button><button type="button" class="ws-icon" id="workspaceRedo" aria-label="Redo hole edit" title="Redo hole edit">${svg('redo')}</button><span class="ws-header-divider"></span><button type="button" class="btn btn-ghost" id="workspaceExport" disabled>${svg('export')}Export</button><button type="button" class="btn btn-primary ws-generate" id="workspaceGenerateBtn" disabled>Generate Model</button>`;
  $('.header-actions').insertBefore(header, $('#headerCreate'));

  const exportDrawer = document.createElement('dialog'); exportDrawer.id = 'workspaceExportDrawer'; exportDrawer.className = 'ws-export-drawer';
  exportDrawer.innerHTML = `<div class="ws-panel-heading"><div><span class="ws-kicker">TAKE IT TO YOUR SLICER</span><h2>Export your model</h2></div><button class="ws-icon" id="workspaceCloseExport" aria-label="Close export">${svg('close')}</button></div><p class="ws-help">A closed STL, ready for print preparation.</p><dl id="workspaceExportSummary"></dl><button type="button" class="btn btn-primary" id="workspaceDownload">${svg('export')}Download STL</button><button type="button" class="btn btn-ghost" id="workspaceExportPrintPlan">Inspect Print Plan</button><p class="ws-export-note">STL stores geometry, not filament colors. Use the Print Plan to configure filament changes in your slicer. No automatic printer connection is required.</p>`;
  document.body.append(exportDrawer);

  // ArtworkPanel, GeometryPanel, KeychainPanel: preserve existing input identity/listeners.
  const colorCards = [...$('#colorWorkbench .color-rail').querySelectorAll(':scope > .card')];
  move(colorCards[0], '#workspaceColorArtwork'); colorCards[0].querySelector('h3').textContent = 'Image';
  colorCards[0].querySelector('.color-note').textContent = 'Transparent pixels create no geometry.';
  $('#removeBackgroundBtn').textContent = 'Remove background';
  $('#removeBackgroundBtn').title = 'Remove only the detected edge-connected background';
  const dropText = $('#colorDropzone .dz-main'); dropText.innerHTML = 'Replace image <span class="link">or choose a file</span>';
  $('#colorDropzone .dz-hint').textContent = 'Drag & drop · PNG / JPG / WEBP';
  move('.color-palette-head', '#workspaceColorAnalysis'); $('#colorAnalyzeBtn').textContent = 'Analyze Image';
  $('#colorPaletteSize').setAttribute('aria-label', 'Target colors');
  $('#colorPaletteSize').closest('label').querySelector('span').textContent = 'Target colors';
  move('#regionTools', '#workspaceRegionTools');
  move(colorCards[2], '#workspaceColorGeometry'); colorCards[2].querySelector('h3').textContent = 'Geometry';
  $('#colorIncrement').closest('label').querySelector('span').textContent = 'Default layer height';
  const uniform = move('#colorResetHeights', '#workspaceColorGeometry'); uniform.textContent = 'Apply Uniform Heights';
  colorCards[2].querySelector('summary').textContent = 'Advanced · processing, heights & cleanup';
  move(colorCards[3], '#workspaceColorKeychain'); colorCards[3].querySelector('h3').textContent = 'Hanging tab';
  move('#colorPlanCard', '#workspacePrintPlan'); $('#colorPlanCard .card-title').textContent = 'Physical print heights';
  move('#colorCanvasWrap', '#workspacePreview'); move('#colorViewport', '#workspacePreview');
  move('#workspaceToolMessage', '.ws-preview-options');
  move('#printLayerSelect', '#workspacePrintOptions'); move('#colorZoomFit', '#workspaceColorPreviewToolbar');
  for (const selector of ['#colorGenerateBtn','#colorDownloadBtn','#colorStatus','#colorPreviewMode','#colorLayerPanel','#colorPaletteList','#colorOrigThumb']) move(selector, '#workspaceInternals');

  // Older stroke projects use the identical workspace, with their original geometry intact.
  const lineCards = [...$('#lineWorkbench .rail').querySelectorAll(':scope > .card')];
  move(lineCards[0], '#workspaceLineArtwork'); move(lineCards[1], '#workspaceLineGeometry');
  move(lineCards[2], '#workspaceLineKeychain');
  move('#tools', '#workspaceLineKeychain'); move('#lineWorkbench .size-controls', '#workspaceLineKeychain'); move('#snapToggle', '#workspaceLineKeychain');
  move(lineCards[3], '#workspaceLegacyInspector'); move(lineCards[4], '#workspaceLinePrintPlan');
  move('#layerPanel', '#workspaceLegacyLayers'); $('#layerPanel').append($('#layerRelief'));
  const legacyToolbar = $('#lineWorkbench .editor-bottom'); move(legacyToolbar, '#workspaceLinePreviewToolbar');
  move('#canvasWrap', '#workspacePreview'); move('#viewport', '#workspacePreview');
  for (const selector of ['#generateBtn','#downloadBtn','#status','#origThumb']) move(selector, '#workspaceInternals');
  $('#lineWorkbench').hidden = true; $('#colorWorkbench').hidden = true;
  $('#colorCanvasWrap').hidden = true; $('#colorViewport').hidden = true; $('#canvasWrap').hidden = true; $('#viewport').hidden = true;

  const separate = document.createElement('button'); separate.id = 'workspaceSeparate'; separate.className = 'btn btn-ghost'; separate.type = 'button'; separate.textContent = 'Separate into New Layer';
  $('#splitColorRegions').after(separate);
  const newNameLabel = document.createElement('label'); newNameLabel.htmlFor = 'splitLayerName'; newNameLabel.textContent = 'New layer name (optional)'; $('#splitLayerName').before(newNameLabel);
  $('#regionTools > label[for="regionLayerSelect"]').textContent = 'Selected layer';
  $('#regionTools > label[for="regionDestinationSelect"]').textContent = 'Move to existing layer';
  $('#selectColorRegions').textContent = 'Select regions on artwork';
  $('#splitColorRegions').textContent = 'Move to Layer';

  let preview = 'artwork', artworkVersion = 'original', pendingRender = false, layerSignature = '', inspectorSelection = null;
  let generationStartedAt = null, generationTimer = null;

  function setTools(category) {
    root.querySelectorAll('[data-tools]').forEach(panel => { panel.hidden = panel.dataset.tools !== category; });
    root.querySelectorAll('[data-tool-panel]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.toolPanel === category)));
  }
  function setPreview(key) {
    preview = key;
    root.querySelectorAll('[data-preview]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.preview === key)); button.tabIndex = button.dataset.preview === key ? 0 : -1; });
    $('#workspacePreview').setAttribute('aria-labelledby', `workspaceTab-${key}`);
    adapter.preview(key, artworkVersion);
    applyPreview();
    requestAnimationFrame(() => adapter.fit());
  }
  function applyPreview() {
    const state = adapter.state(), isLine = state.mode === 'line', showCanvas = preview === 'regions' || preview === 'print' || (preview === 'artwork' && artworkVersion === 'processed');
    $('#workspaceArtworkViewport').hidden = preview !== 'artwork' || artworkVersion !== 'original' || !state.source;
    $('#colorCanvasWrap').hidden = isLine || !showCanvas || !state.source;
    $('#canvasWrap').hidden = !isLine || !showCanvas || !state.source;
    $('#colorViewport').hidden = isLine || preview !== '3d'; $('#viewport').hidden = !isLine || preview !== '3d';
    $('#workspaceArtworkOptions').hidden = preview !== 'artwork'; $('#workspaceRegionOptions').hidden = preview !== 'regions' || isLine;
    $('#workspacePrintOptions').hidden = preview !== 'print' || isLine;
    $('#workspacePrintNotes').hidden = preview !== 'print' || !state.analyzed;
    $('#workspaceEmpty').hidden = Boolean(state.source) || preview === '3d';
    $('#workspaceViewHelp').textContent = preview === '3d' ? 'Rotate · zoom · pan' : preview === 'print' ? 'Includes support for every higher region' : '';
    $('#workspaceStale').hidden = state.model.generating || !state.model.dirty || preview !== '3d';
    $('#workspaceColorPreviewToolbar').hidden = isLine || preview === '3d' || preview === 'artwork';
    $('#workspaceLinePreviewToolbar').hidden = !isLine || preview === '3d' || preview === 'artwork';
    const toolActive = state.selecting || state.placing;
    $('#workspaceToolMessage').hidden = !toolActive || preview === '3d';
    if (toolActive && preview !== '3d') {
      $('#workspaceArtworkOptions').hidden = true; $('#workspaceRegionOptions').hidden = true; $('#workspacePrintOptions').hidden = true;
    }
    $('#workspaceViewHelp').hidden = toolActive;
    $('#workspaceToolMessageText').textContent = state.placing ? 'Click the canvas to place the hole.' : `${state.selectedCount} regions selected · click again to deselect`;
    $('#workspaceCancelPlacement').hidden = !state.placing;
  }
  function setEngine() {
    const state = adapter.state();
    // Three.js also stamps its canvas with data-engine="three.js r…".
    // Only our explicit processing adapters participate in panel visibility.
    root.querySelectorAll('[data-engine="color"], [data-engine="line"]').forEach(part => { part.hidden = part.dataset.engine !== state.mode; });
    $('#workspaceProcessor').value = state.mode;
    $('#workspaceLayerInspector').hidden = state.mode !== 'color' || !state.selectedId;
    applyPreview(); requestRender();
  }
  function requestRender() {
    if (pendingRender) return;
    pendingRender = true;
    requestAnimationFrame(() => { pendingRender = false; render(); });
  }
  function render() {
    const state = adapter.state(), model = state.model;
    $('#workspaceFileSummary').hidden = !state.source;
    $('#workspaceFileName').textContent = state.filename || 'Untitled artwork'; $('#workspaceFileName').title = state.filename || '';
    $('#workspaceAnalysisSummary').textContent = state.analyzed ? `${state.count} physical layers` : state.source ? 'Ready for analysis' : '';
    $('#colorDropzone .dz-main').innerHTML = state.source ? 'Replace image <span class="link">or choose a file</span>' : 'Upload image <span class="link">or choose a file</span>';
    if (state.url) {
      for (const id of ['workspaceFileThumb','workspaceArtworkImage']) if ($('#'+id).getAttribute('src') !== state.url) $('#'+id).src = state.url;
    }
    $('#workspaceLayerCount').textContent = state.count;
    $('#workspaceStackHeight').textContent = `${state.top.toFixed(2)} mm`;
    $('#workspaceSizeSummary').textContent = state.analyzed ? `${state.width.toFixed(1)} × ${state.height.toFixed(1)} mm` : 'No artwork yet';
    $('#workspaceGeometrySummary').textContent = `${state.base.toFixed(2)} mm base · ${state.top.toFixed(2)} mm total`;
    $('#workspaceCanvasMeta').textContent = state.analyzed ? `${state.wpx} × ${state.hpx} px · ${state.count} layers` : state.filename || 'No image selected';
    $('#workspaceStatus').textContent = state.status || 'Ready when you are.';
    const statusError = state.statusKind === 'err'; $('.ws-status-bar').classList.toggle('is-error', statusError);
    $('#workspaceGenerationError').hidden = !statusError || model.generating;
    $('#workspaceGenerationError').textContent = state.status || '';
    $('#workspaceModelState').textContent = model.generating ? 'Generating…' : model.current ? 'Model current' : model.dirty ? 'Changes not generated' : 'No model yet';
    if (model.generating && generationStartedAt === null) {
      generationStartedAt = performance.now(); generationTimer = setInterval(requestRender, 1000);
    } else if (!model.generating && generationStartedAt !== null) {
      clearInterval(generationTimer); generationTimer = null; generationStartedAt = null;
    }
    const elapsed = generationStartedAt === null ? 0 : Math.floor((performance.now() - generationStartedAt) / 1000);
    $('#workspaceGenerationProgress').hidden = !model.generating;
    $('#workspaceGenerationPhase').textContent = `${state.status || 'Preparing geometry…'} · ${elapsed}s elapsed`;
    const generate = $('#workspaceGenerateBtn');
    generate.disabled = model.generating || state.analyzing || !state.analyzed || !state.count;
    generate.classList.toggle('is-generating', model.generating); generate.classList.toggle('is-current', model.current);
    generate.innerHTML = model.generating ? `<span class="ws-spinner" aria-hidden="true"></span>Generating… ${elapsed}s` : model.current ? `${svg('check')}Model Updated` : model.dirty ? 'Update Model' : 'Generate Model';
    generate.setAttribute('aria-busy', String(model.generating));
    $('#workspaceExport').disabled = !model.current || model.generating;
    $('#workspaceDownload').disabled = !model.current || model.generating;
    const historyDisabled = state.mode !== 'line';
    $('#workspaceUndo').disabled = historyDisabled || !state.canUndo; $('#workspaceRedo').disabled = historyDisabled || !state.canRedo;
    $('#workspaceUndo').title = historyDisabled ? 'Undo is currently available for stroke hole edits only' : 'Undo hole edit';
    $('#workspaceRedo').title = historyDisabled ? 'Redo is currently available for stroke hole edits only' : 'Redo hole edit';
    if (state.mode === 'color') {
      if (inspectorSelection !== state.selectedId) {
        inspectorSelection = state.selectedId;
        $('.ws-inspector-scroll').scrollTop = 0;
      }
      const signature=JSON.stringify([state.selectedId,state.increment,state.analyzing,state.layers.map(({id,name,hex,ignored,visible,pixel_count,height_mm})=>[id,name,hex,ignored,visible,pixel_count,height_mm])]);
      if(signature!==layerSignature){layerSignature=signature;renderLayerList($('#workspaceLayerList'), state, adapter.layers);}
      syncLayerInspector($('#workspaceLayerInspector'), state);
      const chosen = state.layers.find(layer => layer.id === state.selectedId);
      $('#selectColorRegions').disabled = state.analyzing || !chosen || chosen.ignored || !chosen.pixel_count;
      $('#workspaceCanvasSelect').disabled = $('#selectColorRegions').disabled;
      $('#workspaceRegionTools').hidden = !chosen || chosen.ignored;
      $('#workspaceSelectedCount').textContent = `${state.selectedCount} selected`;
      $('#workspaceSeparate').disabled = state.analyzing || !state.selectedCount;
      $('#splitColorRegions').disabled = state.analyzing || !state.selectedCount || !$('#regionDestinationSelect').value;
      $('#regionLayerSelect').disabled = state.analyzing;
      $('#regionDestinationSelect').disabled = state.analyzing;
      $('#splitColorRegions').textContent = 'Move to Layer';
      const emptyDestination = $('#regionDestinationSelect option[value=""]');
      if (emptyDestination) emptyDestination.textContent = 'Choose a same-color layer…';
      $('#splitLayerName').hidden = false;
      $('#workspaceRegionEmpty').hidden = Boolean(chosen && !chosen.ignored);
      $('#workspaceRegionEmpty').textContent = chosen?.ignored ? 'Include this layer in the model before selecting its regions.' : 'Select a layer to edit its connected regions.';
      if (state.layers.length) $('#regionSelectionInfo').textContent = 'Select multiple regions by clicking them. Existing destinations must share this layer’s color.';
    }
    applyPreview();
    if (exportDrawer.open) renderExport();
  }
  function renderExport() {
    const state = adapter.state(), summary = $('#workspaceExportSummary'); summary.replaceChildren();
    const rows = [['Artwork size',`${state.width.toFixed(1)} × ${state.height.toFixed(1)} mm`],['Physical layers',String(state.count)],['Base thickness',`${state.base.toFixed(2)} mm`],['Artwork top',`${state.top.toFixed(2)} mm`]];
    if (state.tabHeight) rows.push(['Hanging tab height',`${state.tabHeight.toFixed(2)} mm`]);
    rows.push(['Slicer layer',`${state.slicer.toFixed(2)} mm`],['File',state.fileSize || 'Generate a current model first']);
    rows.forEach(([label,value]) => { const term = document.createElement('dt'), definition = document.createElement('dd'); term.textContent = label; definition.textContent = value; summary.append(term, definition); });
  }
  function closeDrawers() { root.classList.remove('show-tools','show-layers'); $('#workspaceCloseDrawers').hidden = true; }
  function cancelTool() { adapter.cancel(); requestRender(); }

  root.querySelectorAll('[data-tool-panel]').forEach(button => button.addEventListener('click', () => setTools(button.dataset.toolPanel)));
  root.querySelectorAll('[data-preview]').forEach(button => {
    button.addEventListener('click', () => setPreview(button.dataset.preview));
    button.addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const buttons = [...root.querySelectorAll('[data-preview]')], index = buttons.indexOf(button), next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length; setPreview(buttons[next].dataset.preview); buttons[next].focus(); });
  });
  root.querySelectorAll('[data-artwork-version]').forEach(button => button.addEventListener('click', () => { artworkVersion = button.dataset.artworkVersion; root.querySelectorAll('[data-artwork-version]').forEach(b => b.setAttribute('aria-pressed', String(b===button))); setPreview('artwork'); }));
  async function runGenerate() {
    try {
      const operation = adapter.generate();
      // Show feedback synchronously, before any Worker/network response.
      render();
      await operation;
    } catch (error) {
      adapter.reportError(error.message || 'Model generation failed. Please try again.');
    } finally { render(); }
  }
  $('#workspaceGenerateBtn').addEventListener('click', runGenerate);
  $('#workspaceStaleUpdate').addEventListener('click', runGenerate);
  $('#workspaceExport').addEventListener('click', () => { renderExport(); exportDrawer.showModal(); });
  $('#workspaceCloseExport').addEventListener('click', () => exportDrawer.close());
  $('#workspaceDownload').addEventListener('click', () => adapter.download());
  $('#workspaceExportPrintPlan').addEventListener('click', () => { exportDrawer.close(); setPreview('print'); });
  $('#workspaceUpload').addEventListener('click', () => adapter.upload());
  $('#workspaceExample').addEventListener('click', () => adapter.example());
  $('#workspaceStrokeAnalyze').addEventListener('click', () => adapter.analyze());
  $('#workspaceProcessor').addEventListener('change', event => adapter.engine(event.target.value));
  $('#workspaceUndo').addEventListener('click', () => { adapter.undo(); requestRender(); });
  $('#workspaceRedo').addEventListener('click', () => { adapter.redo(); requestRender(); });
  $('#workspaceLayerName').addEventListener('input', event => adapter.layers.rename(event.target.value));
  $('#workspaceLayerHeight').addEventListener('input', event => adapter.layers.height(event.target.value));
  $('#workspaceIncludeLayer').addEventListener('change', event => adapter.layers.include(event.target.checked));
  $('#workspaceCanvasSelect').addEventListener('click', () => { setPreview('regions'); $('#selectColorRegions').click(); });
  $('#selectColorRegions').addEventListener('click', () => { if (adapter.state().selecting) { setPreview('regions'); closeDrawers(); } requestRender(); });
  $('#workspaceSeparate').addEventListener('click', () => { $('#regionDestinationSelect').value = ''; adapter.separate(); });
  $('#workspaceCancelPlacement').addEventListener('click', cancelTool); $('#workspaceCancelTool').addEventListener('click', cancelTool);
  $('#colorHolePlace').addEventListener('click', () => { if (adapter.state().placing) { setPreview('regions'); closeDrawers(); } requestRender(); });
  $('#toolHole').addEventListener('click', () => { setPreview('regions'); closeDrawers(); requestRender(); });
  $('#workspaceOpenTools').addEventListener('click', () => { root.classList.add('show-tools'); root.classList.remove('show-layers'); $('#workspaceCloseDrawers').hidden = false; });
  $('#workspaceOpenLayers').addEventListener('click', () => { root.classList.add('show-layers'); root.classList.remove('show-tools'); $('#workspaceCloseDrawers').hidden = false; });
  $('#workspaceCloseDrawers').addEventListener('click', closeDrawers); root.querySelectorAll('[data-close-sidebar]').forEach(button => button.addEventListener('click', closeDrawers));
  ['dragover','dragenter'].forEach(type => $('#workspacePreview').addEventListener(type, event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); $('#workspacePreview').classList.add('is-drop-target'); } }));
  ['drop','dragleave'].forEach(type => $('#workspacePreview').addEventListener(type, event => { if (type === 'drop') { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) adapter.source(file); } $('#workspacePreview').classList.remove('is-drop-target'); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { cancelTool(); closeDrawers(); } });
  const observer = new ResizeObserver(() => adapter.fit()); observer.observe($('#workspacePreview'));
  const enterStudio = () => {
    document.body.classList.add('is-editing');
    requestAnimationFrame(() => $('#forge').scrollIntoView({block:'start',behavior:'instant'}));
  };
  const syncRoute = () => {
    if (location.hash === '#forge') enterStudio();
    else {
      document.body.classList.remove('is-editing');
      const target = /^#[a-z]+$/.test(location.hash) ? $(location.hash) : null;
      if (target) requestAnimationFrame(() => target.scrollIntoView({behavior:'instant'}));
    }
  };
  const updateHeader = () => {
    const rect = $('#forge').getBoundingClientRect();
    // Explicit editor navigation keeps its actions available while async
    // artwork/model layout changes or scroll anchoring move the section.
    document.body.classList.toggle('is-editing', location.hash === '#forge' || (rect.top < window.innerHeight * .75 && rect.bottom > 160));
  };
  $('#headerCreate').addEventListener('click', () => { location.hash = 'forge'; enterStudio(); });
  window.addEventListener('scroll', updateHeader, {passive:true}); window.addEventListener('hashchange', syncRoute); syncRoute();
  setEngine(); render();

  return {
    refresh: requestRender, setEngine, setPreview, setTools,
    resetModel() { requestRender(); },
    get preview() { return preview; }, get artworkVersion() { return artworkVersion; },
    generated() { setPreview('3d'); requestRender(); },
  };
}
