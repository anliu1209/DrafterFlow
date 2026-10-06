"""Ensure the Color Mode release does not expose local-only account features."""
import unittest
import inspect

from server import app, index, ASSET_REVISION


class ReleaseScopeTests(unittest.TestCase):
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
