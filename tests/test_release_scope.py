"""Ensure the Color Mode release does not expose local-only account features."""
import unittest
import inspect
import asyncio
from pathlib import Path

from server import app, index, ASSET_REVISION


class ReleaseScopeTests(unittest.TestCase):
    def test_static_assets_are_served(self):
        static_route = next((route for route in app.routes if route.path == '/static'), None)
        self.assertIsNotNone(static_route, 'The editor static route must be registered at module scope')
        for filename in ('app.js', 'style.css'):
            response = asyncio.run(static_route.app.get_response(filename, {'method': 'GET', 'headers': []}))
            self.assertEqual(response.status_code, 200)

    def test_preview_dependencies_are_bundled_with_static_assets(self):
        static = Path(__file__).resolve().parents[1] / 'static'
        for filename in ('three.module.js', 'STLLoader.js', 'OrbitControls.js', 'BufferGeometryUtils.js'):
            self.assertGreater((static / 'vendor' / filename).stat().st_size, 1000)
        bundle = (static / 'app.js').read_text()
        self.assertGreater(len(bundle), 400_000)
        self.assertNotIn('from "three"', bundle)
        self.assertNotIn('type="importmap"', index().body.decode())

    def test_colour_pipelines_run_off_the_event_loop(self):
        for route in app.routes:
            if route.path in ('/api/color/analyze', '/api/color/generate'):
                self.assertFalse(inspect.iscoroutinefunction(route.endpoint))

    def test_page_assets_are_versioned_on_every_release(self):
        response = index()
        html = response.body.decode()
        for asset in ('app.js', 'style.css'):
            self.assertIn(f'/static/{asset}?v={ASSET_REVISION}', html)
        self.assertEqual(response.headers['cache-control'], 'no-cache')

    def test_only_editor_routes_are_exposed(self):
        paths = {route.path for route in app.routes}
        self.assertTrue({'/', '/api/analyze', '/api/generate', '/api/color/analyze', '/api/color/generate'} <= paths)
        for path in paths:
            self.assertFalse(path.startswith(('/api/auth', '/api/projects', '/api/community', '/api/shared', '/s/')), path)
