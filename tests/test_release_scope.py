"""Ensure the Color Mode release does not expose local-only account features."""
import unittest

from server import app


class ReleaseScopeTests(unittest.TestCase):
    def test_only_editor_routes_are_exposed(self):
        paths = {route.path for route in app.routes}
        self.assertTrue({'/', '/api/analyze', '/api/generate', '/api/color/analyze', '/api/color/generate'} <= paths)
        for path in paths:
            self.assertFalse(path.startswith(('/api/auth', '/api/projects', '/api/community', '/api/shared', '/s/')), path)

