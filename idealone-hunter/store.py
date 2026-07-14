"""
IdealOne.Hunter — shared document store (Python side)
=====================================================
Mirrors lib/hunter/db.js so the pipeline reads/writes the SAME data the CRM
web app uses. PostgreSQL (JSONB) when DATABASE_URL is set, JSON files under
../data otherwise. Collections: orgs | staff | leads | events.
"""

import json
import os

_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
_DB_URL = os.environ.get("DATABASE_URL")

_pg = None
if _DB_URL:
    import psycopg2
    import psycopg2.extras

    _pg = psycopg2.connect(_DB_URL)
    _pg.autocommit = True
    with _pg.cursor() as cur:
        cur.execute(
            """CREATE TABLE IF NOT EXISTS hunter_docs (
                 collection TEXT NOT NULL,
                 id         TEXT NOT NULL,
                 doc        JSONB NOT NULL,
                 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                 PRIMARY KEY (collection, id))"""
        )

backend = "postgres" if _pg else "json-file"


def _file(col):
    return os.path.join(_DIR, f"hunter-{col}.json")


def list_docs(col):
    if _pg:
        with _pg.cursor() as cur:
            cur.execute("SELECT doc FROM hunter_docs WHERE collection=%s", (col,))
            return [row[0] for row in cur.fetchall()]
    try:
        with open(_file(col)) as f:
            return list(json.load(f).values())
    except (OSError, ValueError):
        return []


def put(col, doc_id, doc):
    if _pg:
        with _pg.cursor() as cur:
            cur.execute(
                """INSERT INTO hunter_docs (collection, id, doc) VALUES (%s, %s, %s)
                   ON CONFLICT (collection, id) DO UPDATE SET doc=%s, updated_at=NOW()""",
                (col, doc_id, json.dumps(doc), json.dumps(doc)),
            )
        return doc
    path = _file(col)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data[doc_id] = doc
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    return doc


def orgs():
    return list_docs("orgs")


def leads_for(org_id):
    return [l for l in list_docs("leads") if l.get("org_id") == org_id]
