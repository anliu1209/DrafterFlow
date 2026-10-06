"""Structural regressions for the vanilla-JS workspace adapter."""
from html.parser import HTMLParser
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class IdParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids = []
    def handle_starttag(self, tag, attrs):
        self.ids.extend(value for key, value in attrs if key == 'id')

class WorkspaceContractTests(unittest.TestCase):
    def test_separations_have_optional_names_and_layers_are_renameable(self):
        html = (ROOT / 'static/index.html').read_text()
        self.assertNotIn('value="Highlights"', html)
        app = (ROOT / 'static/app.js').read_text()
        self.assertIn("separationLayerName(colorLayerName(source), $('#splitLayerName').value)", app)
        self.assertIn("$('#splitLayerName').value = ''", app)
        self.assertIn('renameStart(id)', app)
        panel = (ROOT / 'static/layers-panel.js').read_text()
        self.assertIn('actions.renameStart(entry.id)', panel)
        self.assertIn('`Rename ${name}`', panel)
        workspace = (ROOT / 'static/workspace.js').read_text()
        self.assertIn("adapter.layers.rename(event.target.value)", workspace)

    def test_default_added_height_is_half_mm_without_overwriting_saved_heights(self):
        html = (ROOT / 'static/index.html').read_text()
        self.assertIn('id="colorIncrement" value="0.5"', html)
        app = (ROOT / 'static/app.js').read_text()
        self.assertIn("$('#colorIncrement').value = '0.5'", app)
        self.assertIn("increment: '#colorIncrement'", app)
        server = (ROOT / 'server.py').read_text()
        self.assertIn('increment: str = Form("0.5")', server)

    def test_generation_feedback_is_immediate_and_every_success_shows_3d(self):
        source = (ROOT / 'static/workspace.js').read_text()
        self.assertIn("generated() { setPreview('3d'); requestRender(); }", source)
        self.assertNotIn('seenModels', source)
        self.assertIn('async function runGenerate()', source)
        self.assertLess(source.index('render();', source.index('async function runGenerate()')), source.index('await operation;'))
        self.assertIn("addEventListener('click', runGenerate)", source)
        self.assertIn('workspaceGenerationProgress', source)
        self.assertIn('adapter.reportError(', source)
        self.assertIn("location.hash === '#forge' || (rect.top", source)

    def test_color_local_compute_is_default_and_server_is_explicit(self):
        html = (ROOT / 'static/index.html').read_text()
        self.assertIn('value="local" selected', html)
        app = (ROOT / 'static/app.js').read_text()
        self.assertIn("localCompute.run('analyze'", app)
        self.assertIn("localCompute.run('generate'", app)
        self.assertIn('analysisId: colorAnalysis.local_analysis_id', app)
        self.assertIn("localCompute.reset();", app)
        local = (ROOT / 'static/local-compute.js').read_text()
        self.assertNotIn('fetch(', local)
        self.assertIn("type: 'module'", local)
        worker = (ROOT / 'static/local-compute-worker.js').read_text()
        self.assertIn('payload.analysisId !== analysisSequence', worker)
        self.assertIn('[result.stl]', worker)
        model = (ROOT / 'static/local-color-model.js').read_text()
        self.assertIn('closedMesh(delivered)', model)
        self.assertIn('owned[i].delete()', model)

    def test_four_step_story_and_its_navigation_are_removed(self):
        html = (ROOT / 'static/index.html').read_text()
        self.assertNotIn('id="how"', html)
        self.assertNotIn('href="#how"', html)
        self.assertNotIn('A short path from image to object.', html)

    def test_published_metadata_editor_is_independent_of_open_model(self):
        source = (ROOT / 'static/app.js').read_text()
        self.assertIn('project.creator.id !== currentUser.id', source)
        self.assertIn('if (!editingId && !await saveCurrentProject()) return;', source)
        self.assertIn('const targetId = editingId || currentProjectId', source)
        self.assertIn("cardButton('Edit details'", source)

    def test_preview_lighting_and_compact_uncropped_cards(self):
        source = (ROOT / 'static/app.js').read_text()
        self.assertIn('addStudioLighting(renderer, scene)', source)
        self.assertIn('addStudioLighting(colorRenderer, colorScene)', source)
        self.assertNotIn('ACESFilmicToneMapping', source)
        css = (ROOT / 'static/style.css').read_text()
        self.assertIn('repeat(auto-fill, minmax(min(100%, 260px), 300px))', css)
        self.assertIn('aspect-ratio: 4 / 3', css)
        self.assertIn('padding: 12px; object-fit: contain', css)
        self.assertIn('max-width: 300px; min-width: 0', css)
        html = (ROOT / 'static/index.html').read_text()
        self.assertIn('/static/style.css?v=compact-gallery-2', html)
        self.assertIn('/static/workspace.css?v=', html)

    def test_existing_controls_keep_unique_identity(self):
        parser = IdParser(); parser.feed((ROOT / 'static/index.html').read_text())
        self.assertEqual(len(parser.ids), len(set(parser.ids)))
        required = ('editorWorkspace colorFileInput colorPaletteSize colorAnalyzeBtn '
            'backgroundTools removeBackgroundBtn restoreBackgroundBtn colorCanvas colorViewport '
            'regionLayerSelect regionDestinationSelect splitLayerName splitColorRegions clearColorRegions '
            'colorWidth colorBase colorIncrement colorLayerHeights colorResetHeights colorCleanup '
            'colorSlicerLayer colorHoleEnabled colorHoleDiameter colorHoleHeight colorHoleX colorHoleY '
            'colorHoleAuto colorHolePlace colorGenerateBtn colorDownloadBtn printLayerSelect '
            'fileInput darkThreshold alphaThreshold holeList editorCanvas threeCanvas').split()
        for identifier in required: self.assertIn(identifier, parser.ids)

    def test_all_four_preview_views_and_region_actions_exist(self):
        source = (ROOT / 'static/workspace.js').read_text()
        for label in ('Artwork', 'Regions', 'Print Plan', '3D', 'Move to Layer', 'Separate into New Layer'):
            self.assertIn(label, source)
        self.assertIn('application/x-drafterflow-layer', (ROOT / 'static/layers-panel.js').read_text())

    def test_physical_display_order_matches_bottom_up_model_order(self):
        source = (ROOT / 'static/layers-panel.js').read_text()
        self.assertIn('state.layers.forEach((entry)', source)
        self.assertNotIn('[...state.layers].reverse()', source)
        self.assertIn("iconButton('up', `Move ${name} lower`, () => actions.move(index, -1))", source)
        self.assertIn("iconButton('down', `Move ${name} higher`, () => actions.move(index, 1))", source)
        workspace = (ROOT / 'static/workspace.js').read_text()
        self.assertIn('Physical layers, bottom to top', workspace)
        self.assertIn('BOTTOM · first printed', workspace)
        self.assertIn('TOP · last printed', workspace)
        self.assertIn("$('#layerPanel').append($('#layerRelief'))", workspace)

    def test_renderer_engine_stamp_does_not_hide_three_canvas(self):
        source = (ROOT / 'static/workspace.js').read_text()
        self.assertIn('[data-engine="color"], [data-engine="line"]', source)
        self.assertNotIn("querySelectorAll('[data-engine]')", source)

    def test_backend_contracts_and_original_stroke_pipeline_remain(self):
        source = (ROOT / 'static/app.js').read_text()
        for path in ('/api/analyze', '/api/generate', '/api/color/analyze', '/api/color/generate'):
            self.assertIn(path, source)
        for key in ('region_seeds', 'excluded_region_seeds', 'height_mm', 'source_color_id', 'base_hole'):
            self.assertIn(key, source)

    def test_hydrangea_tokens_are_exact(self):
        css = (ROOT / 'static/workspace.css').read_text()
        for color in ('#3A4267', '#96A0D1', '#BAD3F1', '#E1E4DB', '#FBF4D8'):
            self.assertIn(color, css)

    def test_opening_example_is_chef_without_overwriting_existing_artwork(self):
        source = (ROOT / 'static/app.js').read_text()
        self.assertIn("fetch('/static/examples/chef.png')", source)
        self.assertIn('await loadDefaultChef()', source)
        helper = source.split('async function loadDefaultChef()')[1].split('async function bootstrapAccount()')[0]
        self.assertEqual(helper.count('if (hasArtwork()) return;'), 2)
        self.assertIn("$('#colorPaletteSize').value = '5'", helper)
        self.assertTrue((ROOT / 'static/examples/chef.png').exists())

    def test_home_showcases_actual_chef_pipeline(self):
        html = (ROOT / 'static/index.html').read_text()
        for asset in ('chef.png', 'chef-model-preview.png', 'chef-print.png'):
            self.assertIn('/static/examples/' + asset, html)
            self.assertTrue((ROOT / 'static/examples' / asset).exists())
        self.assertNotIn('data-example="nametag"', html)

    def test_editor_does_not_lock_document_scroll(self):
        css = (ROOT / 'static/workspace.css').read_text()
        self.assertNotIn('body.is-editing { overflow:hidden;', css)
        self.assertNotIn('body.is-editing .forge { position:fixed;', css)
