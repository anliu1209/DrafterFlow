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

    def test_physical_display_order_is_reverse_of_model_order(self):
        self.assertIn('[...state.layers].reverse()', (ROOT / 'static/layers-panel.js').read_text())

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
        for asset in ('chef.png', 'chef-model.jpg', 'chef-print.png'):
            self.assertIn('/static/examples/' + asset, html)
            self.assertTrue((ROOT / 'static/examples' / asset).exists())
        self.assertNotIn('data-example="nametag"', html)

    def test_editor_does_not_lock_document_scroll(self):
        css = (ROOT / 'static/workspace.css').read_text()
        self.assertNotIn('body.is-editing { overflow:hidden;', css)
        self.assertNotIn('body.is-editing .forge { position:fixed;', css)
