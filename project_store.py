"""Small, dependency-free persistence layer for DrafterFlow.

The editor remains useful without an account.  This module only owns durable
account/project/community records; the browser is still responsible for keeping
the in-progress guest draft in localStorage until a user chooses to save it.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DF_DATABASE_PATH", ROOT / "data" / "drafterflow.db"))
MAX_PROJECT_DATA_BYTES = 14 * 1024 * 1024
SHARE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class StoreError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              email TEXT NOT NULL UNIQUE COLLATE NOCASE,
              display_name TEXT NOT NULL,
              password_hash TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              mode TEXT NOT NULL CHECK(mode IN ('line', 'color')),
              project_data TEXT NOT NULL,
              schema_version INTEGER NOT NULL DEFAULT 1,
              thumbnail TEXT,
              share_code TEXT UNIQUE,
              share_active INTEGER NOT NULL DEFAULT 0,
              allow_remix INTEGER NOT NULL DEFAULT 1,
              remixed_from_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS projects_owner_updated ON projects(owner_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS community_submissions (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              tags TEXT NOT NULL DEFAULT '[]',
              published_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS community_published ON community_submissions(published_at DESC);
            """
        )


def _json(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value) if value else fallback
    except json.JSONDecodeError:
        return fallback


def _public_user(row: sqlite3.Row | None) -> dict[str, str] | None:
    return None if row is None else {"id": row["id"], "name": row["display_name"]}


def user_for_id(user_id: str) -> dict[str, str] | None:
    with _connect() as conn:
        return _public_user(conn.execute("SELECT id, display_name FROM users WHERE id = ?", (user_id,)).fetchone())


def _hash_password(password: str, salt: bytes | None = None) -> str:
    if not isinstance(password, str) or len(password) < 8:
        raise StoreError("Password must be at least 8 characters.")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return "pbkdf2_sha256$310000$" + salt.hex() + "$" + digest.hex()


def _password_matches(password: str, stored: str) -> bool:
    try:
        _, rounds, salt_hex, digest_hex = stored.split("$", 3)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds))
        return secrets.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def create_user(email: str, password: str, display_name: str | None = None) -> dict[str, str]:
    email = (email or "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise StoreError("Enter a valid email address.")
    name = (display_name or email.split("@", 1)[0]).strip()[:48]
    if not name:
        name = "Maker"
    user = {"id": str(uuid.uuid4()), "email": email, "name": name}
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO users (id,email,display_name,password_hash,created_at) VALUES (?,?,?,?,?)",
                (user["id"], email, name, _hash_password(password), _now()),
            )
    except sqlite3.IntegrityError as exc:
        raise StoreError("An account with that email already exists.") from exc
    return user


def authenticate(email: str, password: str) -> dict[str, str] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", ((email or "").strip().lower(),)).fetchone()
    if row is None or not _password_matches(password or "", row["password_hash"]):
        return None
    return {"id": row["id"], "email": row["email"], "name": row["display_name"]}


def create_session(user_id: str, days: int = 30) -> str:
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expiry = (datetime.now(UTC) + timedelta(days=days)).replace(microsecond=0).isoformat()
    with _connect() as conn:
        conn.execute("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)", (token_hash, user_id, expiry, _now()))
    return token


def delete_session(token: str | None) -> None:
    if not token:
        return
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))


def user_for_session(token: str | None) -> dict[str, str] | None:
    if not token:
        return None
    with _connect() as conn:
        row = conn.execute(
            """SELECT u.id, u.email, u.display_name, s.expires_at FROM sessions s
               JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?""",
            (hashlib.sha256(token.encode()).hexdigest(),),
        ).fetchone()
        if row is None:
            return None
        if datetime.fromisoformat(row["expires_at"]) <= datetime.now(UTC):
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
            return None
    return {"id": row["id"], "email": row["email"], "name": row["display_name"]}


def _clean_title(value: Any, fallback: str = "Untitled project") -> str:
    title = str(value or "").strip().replace("\n", " ")[:80]
    return title or fallback


def _clean_mode(value: Any) -> str:
    if value not in {"line", "color"}:
        raise StoreError("Project mode must be line or color.")
    return value


def _project_payload(payload: dict[str, Any]) -> tuple[str, str, str, int, str | None]:
    if not isinstance(payload, dict) or not isinstance(payload.get("projectData"), dict):
        raise StoreError("Project data is required.")
    data = json.dumps(payload["projectData"], separators=(",", ":"))
    if len(data.encode()) > MAX_PROJECT_DATA_BYTES:
        raise StoreError("Project is too large to save. Try a smaller source image.")
    thumbnail = payload.get("thumbnail")
    if thumbnail is not None and (not isinstance(thumbnail, str) or len(thumbnail) > 1_000_000):
        raise StoreError("Project thumbnail is invalid.")
    version = int(payload.get("schemaVersion", 1))
    return _clean_title(payload.get("title")), _clean_mode(payload.get("mode")), data, version, thumbnail


def _visibility(row: sqlite3.Row) -> str:
    if row["published_at"]:
        return "published"
    if row["share_active"]:
        return "unlisted"
    return "private"


def _project_summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "title": row["title"], "mode": row["mode"], "thumbnail": row["thumbnail"],
        "updatedAt": row["updated_at"], "createdAt": row["created_at"], "visibility": _visibility(row),
        "isPublished": bool(row["published_at"]), "isShared": bool(row["share_active"]),
        "shareCode": row["share_code"] if row["share_active"] else None,
        "allowRemix": bool(row["allow_remix"]), "remixedFromProjectId": row["remixed_from_project_id"],
    }


def _project_row(conn: sqlite3.Connection, project_id: str) -> sqlite3.Row | None:
    return conn.execute(
        """SELECT p.*, cs.id AS submission_id, cs.published_at, cs.title AS published_title,
                  cs.description AS published_description, cs.tags AS published_tags
             FROM projects p LEFT JOIN community_submissions cs ON cs.project_id = p.id
             WHERE p.id = ?""", (project_id,)
    ).fetchone()


def save_project(owner_id: str, payload: dict[str, Any], project_id: str | None = None) -> dict[str, Any]:
    title, mode, data, version, thumbnail = _project_payload(payload)
    now = _now()
    with _connect() as conn:
        if project_id:
            current = _project_row(conn, project_id)
            if current is None or current["owner_id"] != owner_id:
                raise StoreError("Project not found.")
            conn.execute(
                """UPDATE projects SET title=?, mode=?, project_data=?, schema_version=?, thumbnail=?, updated_at=?
                   WHERE id=?""", (title, mode, data, version, thumbnail, now, project_id),
            )
        else:
            project_id = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO projects (id,owner_id,title,mode,project_data,schema_version,thumbnail,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""", (project_id, owner_id, title, mode, data, version, thumbnail, now, now),
            )
        row = _project_row(conn, project_id)
    return _project_summary(row)


def list_projects(owner_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT p.*, cs.id AS submission_id, cs.published_at, cs.title AS published_title,
                      cs.description AS published_description, cs.tags AS published_tags
               FROM projects p LEFT JOIN community_submissions cs ON cs.project_id=p.id
               WHERE p.owner_id=? ORDER BY p.updated_at DESC""", (owner_id,)
        ).fetchall()
    return [_project_summary(row) for row in rows]


def get_owned_project(owner_id: str, project_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = _project_row(conn, project_id)
    if row is None or row["owner_id"] != owner_id:
        return None
    result = _project_summary(row)
    result["projectData"] = _json(row["project_data"], {})
    return result


def delete_project(owner_id: str, project_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM projects WHERE id=? AND owner_id=?", (project_id, owner_id))
    return cur.rowcount > 0


def duplicate_project(owner_id: str, project_id: str) -> dict[str, Any]:
    item = get_owned_project(owner_id, project_id)
    if item is None:
        raise StoreError("Project not found.")
    return save_project(owner_id, {"title": item["title"] + " copy", "mode": item["mode"], "projectData": item["projectData"], "thumbnail": item["thumbnail"], "schemaVersion": 1})


def _new_share_code(conn: sqlite3.Connection) -> str:
    for _ in range(20):
        code = "".join(secrets.choice(SHARE_ALPHABET) for _ in range(8))
        if conn.execute("SELECT 1 FROM projects WHERE share_code=?", (code,)).fetchone() is None:
            return code
    raise StoreError("Could not create a share code. Please try again.")


def create_share(owner_id: str, project_id: str) -> dict[str, str]:
    with _connect() as conn:
        row = _project_row(conn, project_id)
        if row is None or row["owner_id"] != owner_id:
            raise StoreError("Project not found.")
        code = row["share_code"] or _new_share_code(conn)
        conn.execute("UPDATE projects SET share_code=?, share_active=1, updated_at=? WHERE id=?", (code, _now(), project_id))
    return {"code": code, "path": f"/s/{code}"}


def get_shared_project(code: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            """SELECT p.*, cs.id AS submission_id, cs.published_at, cs.title AS published_title,
                      cs.description AS published_description, cs.tags AS published_tags, u.display_name
               FROM projects p LEFT JOIN community_submissions cs ON cs.project_id=p.id
               JOIN users u ON u.id=p.owner_id WHERE p.share_code=? AND p.share_active=1""", (code.upper(),)
        ).fetchone()
    if row is None:
        return None
    result = _project_summary(row)
    result.update({"projectData": _json(row["project_data"], {}), "creator": {"name": row["display_name"]}, "canRemix": bool(row["allow_remix"])})
    return result


def remix_project(owner_id: str, source_id: str) -> dict[str, Any]:
    with _connect() as conn:
        source = _project_row(conn, source_id)
        if source is None or not (source["share_active"] or source["published_at"]) or not source["allow_remix"]:
            raise StoreError("This project is not available for remixing.")
        now = _now(); project_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO projects (id,owner_id,title,mode,project_data,schema_version,thumbnail,allow_remix,remixed_from_project_id,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (project_id, owner_id, _clean_title(source["title"] + " remix"), source["mode"], source["project_data"], source["schema_version"], source["thumbnail"], source["allow_remix"], source["id"], now, now),
        )
        row = _project_row(conn, project_id)
    return _project_summary(row)


def publish_project(owner_id: str, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    title = _clean_title(payload.get("title")); description = str(payload.get("description") or "").strip()[:600]
    raw_tags = payload.get("tags") or []
    if isinstance(raw_tags, str): raw_tags = [x.strip() for x in raw_tags.split(",")]
    tags = [str(x).strip()[:24] for x in raw_tags if str(x).strip()][:8]
    allow = bool(payload.get("allowRemix", True)); now = _now()
    with _connect() as conn:
        row = _project_row(conn, project_id)
        if row is None or row["owner_id"] != owner_id: raise StoreError("Project not found.")
        conn.execute("UPDATE projects SET title=?, allow_remix=?, updated_at=? WHERE id=?", (title, int(allow), now, project_id))
        if row["submission_id"]:
            conn.execute("UPDATE community_submissions SET title=?,description=?,tags=?,updated_at=? WHERE project_id=?", (title, description, json.dumps(tags), now, project_id))
        else:
            conn.execute("INSERT INTO community_submissions (id,project_id,title,description,tags,published_at,updated_at) VALUES (?,?,?,?,?,?,?)", (str(uuid.uuid4()), project_id, title, description, json.dumps(tags), now, now))
    return get_community_project(project_id)  # type: ignore[return-value]


def unpublish_project(owner_id: str, project_id: str) -> bool:
    with _connect() as conn:
        row = _project_row(conn, project_id)
        if row is None or row["owner_id"] != owner_id: raise StoreError("Project not found.")
        conn.execute("DELETE FROM community_submissions WHERE project_id=?", (project_id,))
    return True


def _community_item(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["project_id"], "title": row["title"], "description": row["description"], "tags": _json(row["tags"], []),
        "thumbnail": row["thumbnail"], "mode": row["mode"], "publishedAt": row["published_at"],
        "updatedAt": row["updated_at"], "creator": {"id": row["owner_id"], "name": row["display_name"]},
        "allowRemix": bool(row["allow_remix"]), "remixCount": row["remix_count"],
    }


def list_community() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT cs.project_id,cs.title,cs.description,cs.tags,cs.published_at,cs.updated_at,
                      p.owner_id,p.thumbnail,p.mode,p.allow_remix,u.display_name,
                      (SELECT COUNT(*) FROM projects r WHERE r.remixed_from_project_id=p.id) AS remix_count
               FROM community_submissions cs JOIN projects p ON p.id=cs.project_id JOIN users u ON u.id=p.owner_id
               ORDER BY cs.published_at DESC"""
        ).fetchall()
    return [_community_item(row) for row in rows]


def get_community_project(project_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            """SELECT cs.project_id,cs.title,cs.description,cs.tags,cs.published_at,cs.updated_at,
                      p.owner_id,p.thumbnail,p.mode,p.allow_remix,p.project_data,u.display_name,
                      (SELECT COUNT(*) FROM projects r WHERE r.remixed_from_project_id=p.id) AS remix_count
               FROM community_submissions cs JOIN projects p ON p.id=cs.project_id JOIN users u ON u.id=p.owner_id
               WHERE cs.project_id=?""", (project_id,)
        ).fetchone()
    if row is None: return None
    item = _community_item(row); item["projectData"] = _json(row["project_data"], {})
    return item
