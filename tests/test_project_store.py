"""Regression coverage for account/project persistence and public access rules."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import project_store as store


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.original_path = store.DB_PATH
        store.DB_PATH = Path(self.tmp.name) / "drafterflow.db"
        store.init_db()
        self.owner = store.create_user("owner@example.test", "a-long-enough-password", "Owner")
        self.remixer = store.create_user("remixer@example.test", "a-long-enough-password", "Remixer")

    def tearDown(self):
        store.DB_PATH = self.original_path
        self.tmp.cleanup()

    def payload(self, title="Keychain", mode="line"):
        return {
            "title": title,
            "mode": mode,
            "schemaVersion": 1,
            "thumbnail": None,
            "projectData": {"schemaVersion": 1, "mode": mode, "line": {"sourceDataUrl": "data:image/png;base64,AA=="}},
        }

    def test_password_sessions_and_owned_editable_project(self):
        self.assertIsNotNone(store.authenticate("owner@example.test", "a-long-enough-password"))
        self.assertIsNone(store.authenticate("owner@example.test", "wrong-password"))
        token = store.create_session(self.owner["id"])
        self.assertEqual(store.user_for_session(token)["id"], self.owner["id"])
        project = store.save_project(self.owner["id"], self.payload())
        restored = store.get_owned_project(self.owner["id"], project["id"])
        self.assertEqual(restored["projectData"]["line"]["sourceDataUrl"], "data:image/png;base64,AA==")
        self.assertEqual(restored["visibility"], "private")

    def test_unlisted_share_is_public_but_remix_makes_a_new_owner_copy(self):
        source = store.save_project(self.owner["id"], self.payload("Source", "color"))
        share = store.create_share(self.owner["id"], source["id"])
        self.assertEqual(len(share["code"]), 8)
        public = store.get_shared_project(share["code"])
        self.assertEqual(public["id"], source["id"])
        copied = store.remix_project(self.remixer["id"], source["id"])
        self.assertNotEqual(copied["id"], source["id"])
        self.assertEqual(copied["remixedFromProjectId"], source["id"])
        self.assertEqual(store.get_owned_project(self.owner["id"], source["id"])["title"], "Source")

    def test_unpublish_keeps_owner_project_and_removes_community_listing(self):
        project = store.save_project(self.owner["id"], self.payload("Community source"))
        store.publish_project(self.owner["id"], project["id"], {"title": "Community source", "description": "Test", "tags": ["test"], "allowRemix": True})
        self.assertEqual(len(store.list_community()), 1)
        store.unpublish_project(self.owner["id"], project["id"])
        self.assertEqual(store.list_community(), [])
        self.assertIsNotNone(store.get_owned_project(self.owner["id"], project["id"]))

    def test_published_details_edit_preserves_model_and_share(self):
        project = store.save_project(self.owner["id"], self.payload("Original", "color"))
        share = store.create_share(self.owner["id"], project["id"])
        original = store.publish_project(self.owner["id"], project["id"], {"title": "Original"})
        updated = store.publish_project(self.owner["id"], project["id"], {
            "title": "Updated chef", "description": "New description", "tags": "chef, pastel", "allowRemix": False,
        })
        self.assertEqual(updated["title"], "Updated chef")
        self.assertEqual(updated["description"], "New description")
        self.assertEqual(updated["tags"], ["chef", "pastel"])
        self.assertFalse(updated["allowRemix"])
        self.assertEqual(updated["publishedAt"], original["publishedAt"])
        self.assertEqual(updated["projectData"], self.payload("Original", "color")["projectData"])
        self.assertEqual(store.get_shared_project(share["code"])["title"], "Updated chef")
        self.assertEqual(len(store.list_community()), 1)
        with self.assertRaises(store.StoreError):
            store.publish_project(self.remixer["id"], project["id"], {"title": "Not mine"})


if __name__ == "__main__":
    unittest.main()
