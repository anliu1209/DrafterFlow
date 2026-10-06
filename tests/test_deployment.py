"""Deployment safety and cache compatibility without touching user data."""
import os
import unittest
from unittest.mock import patch
from fastapi import HTTPException
import server


class DeploymentTests(unittest.TestCase):
    def test_render_registration_waits_for_persistent_configuration(self):
        with patch.dict(os.environ, {"RENDER": "true"}, clear=True):
            with self.assertRaises(HTTPException) as error:
                server._require_account_storage()
            self.assertEqual(error.exception.status_code, 503)
        with patch.dict(os.environ, {"RENDER": "true", "DF_ACCOUNTS_ENABLED": "1", "DF_DATABASE_PATH": "/var/data/drafterflow.db"}, clear=True):
            server._require_account_storage()

    def test_local_registration_is_unchanged(self):
        with patch.dict(os.environ, {}, clear=True):
            server._require_account_storage()

    def test_html_assets_share_release_version(self):
        response = server.index()
        body = response.body.decode()
        for asset in ("app.js", "style.css", "workspace.css"):
            self.assertIn(f'/static/{asset}?v={server.ASSET_REVISION}"', body)
        self.assertEqual(response.headers["cache-control"], "no-cache")
        self.assertEqual(server.shared_page("test").body, response.body)
