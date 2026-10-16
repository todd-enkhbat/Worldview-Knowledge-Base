-- The SQLite engine's schema (Phase 4). server/worldDb.ts executes this file once per new
-- database (PRAGMA user_version 0 → 1) after loading sqlite-vec. It mirrors
-- src/domain/types.ts; keep it in step when fields are added (unknown NodeRecord keys
-- survive in nodes.extra, so an older server never drops a newer client's fields).
-- Conventions: epoch milliseconds as INTEGER; booleans as INTEGER 0/1; JSON as TEXT checked
-- with json_valid(); ids are uuids (TEXT). Positions and velocities are never stored: they are
-- a deterministic function of (records, settings, step).

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- WorldSettings: a single row.
CREATE TABLE settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  t0                  INTEGER NOT NULL,                 -- birth date / worldview start; never derived from data
  y_per_year          REAL    NOT NULL DEFAULT 12,
  steps_per_year      INTEGER NOT NULL DEFAULT 600,
  physics_seed        INTEGER NOT NULL CHECK (physics_seed BETWEEN 0 AND 4294967295),
  quality_tier        TEXT    NOT NULL DEFAULT 'auto' CHECK (quality_tier IN ('auto', 'high', 'medium', 'low')),
  first_run_complete  INTEGER NOT NULL DEFAULT 0,
  last_backup_at      INTEGER,
  auto_backup_enabled INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  schema_version      INTEGER NOT NULL
);

-- NodeRecord. Per-archetype blocks are JSON columns (they are read whole, never queried).
CREATE TABLE nodes (
  id                 TEXT    PRIMARY KEY,
  slug               TEXT    NOT NULL UNIQUE,
  archetype          TEXT    NOT NULL CHECK (archetype IN ('idea', 'entity', 'lens', 'document', 'memory', 'demon')),
  title              TEXT    NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  content_md         TEXT    NOT NULL DEFAULT '',
  tags               TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),          -- string[]; order matters (first = primary)
  temporal_origin    INTEGER NOT NULL,                                                -- sets Y and the birth step
  temporal_precision TEXT    NOT NULL CHECK (temporal_precision IN ('year', 'month', 'day', 'minute')),
  reference_date     TEXT    CHECK (reference_date IS NULL OR json_valid(reference_date)), -- {epochMs, precision, label?}; display only
  mass               REAL    NOT NULL CHECK (mass BETWEEN 0.25 AND 4),
  temperature        REAL    NOT NULL CHECK (temperature BETWEEN 0 AND 1),
  anchor_x           REAL    NOT NULL,                                                -- frozen at creation
  anchor_z           REAL    NOT NULL,
  visibility         TEXT    NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  splat              TEXT    CHECK (splat IS NULL OR (archetype = 'memory' AND json_valid(splat))),
  entity_kind        TEXT    CHECK (entity_kind IS NULL OR entity_kind IN ('person', 'place', 'organization', 'work', 'other')),
  demon              TEXT    CHECK (demon IS NULL OR json_valid(demon)),              -- {query, radius, active}
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,                                                         -- soft delete (30-day trash)
  schema_version     INTEGER NOT NULL,
  provenance         TEXT    CHECK (provenance IS NULL OR json_valid(provenance)),    -- {source, state, raw?, refinedAt?}
  extra              TEXT    CHECK (extra IS NULL OR json_valid(extra)),              -- NodeRecord keys this schema does not know
  CHECK (anchor_x * anchor_x + anchor_z * anchor_z < 3000 * 3000),
  CHECK (archetype <> 'entity' OR entity_kind IS NOT NULL),
  CHECK (archetype <> 'demon' OR (demon IS NOT NULL AND json_extract(demon, '$.radius') > 0))
);
CREATE INDEX nodes_updated_at ON nodes (updated_at);
CREATE INDEX nodes_deleted_at ON nodes (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX nodes_temporal_origin ON nodes (temporal_origin);

-- Link (NodeRecord.links[]). One row per (source, target, kind).
CREATE TABLE links (
  source_id  TEXT    NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  target_id  TEXT    NOT NULL,                     -- no FK: putNodes writes in id order, and trashed targets only warn
  kind       TEXT    NOT NULL CHECK (kind IN ('relates', 'supports', 'contradicts', 'derives', 'influenced-by')),
  label      TEXT,
  created_at INTEGER NOT NULL,
  ord        INTEGER NOT NULL,                     -- position in links[] (round-trips the array order)
  PRIMARY KEY (source_id, target_id, kind),
  CHECK (source_id <> target_id)
);
CREATE INDEX links_target ON links (target_id);

-- AssetMeta. Bytes live in a content directory (or the blob column below for small assets).
CREATE TABLE assets (
  id         TEXT    PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('splat-proxy', 'splat-interior', 'splat-thumb', 'image', 'image-thumb', 'text')),
  mime       TEXT    NOT NULL,
  bytes      INTEGER NOT NULL CHECK (bytes >= 0),
  created_at INTEGER NOT NULL,
  node_id    TEXT,                                              -- owner, for orphan collection (no FK: scene blobs are written before their record)
  data       BLOB                                               -- unused: bytes live in the blob directory by id
);
CREATE INDEX assets_node ON assets (node_id);

-- Attachment (NodeRecord.attachments[]): images or text logs, backed by assets.
CREATE TABLE attachments (
  id             TEXT    PRIMARY KEY,
  node_id        TEXT    NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('image', 'text')),
  name           TEXT    NOT NULL,
  mime           TEXT    NOT NULL,
  bytes          INTEGER NOT NULL CHECK (bytes >= 0),
  blob_id        TEXT    NOT NULL,                 -- no FK: an import writes records before blobs
  thumb_blob_id  TEXT,
  created_at     INTEGER NOT NULL,
  ord            INTEGER NOT NULL
);
CREATE INDEX attachments_node ON attachments (node_id, ord);

-- InteractionEvent: append-only log driving the dissipative overlays.
CREATE TABLE events (
  id         TEXT    PRIMARY KEY,
  t          INTEGER NOT NULL,                     -- wall clock, not the scrub
  kind       TEXT    NOT NULL CHECK (kind IN ('dwell', 'inspect', 'enter', 'demon-match')),
  node_id    TEXT    NOT NULL,                     -- no FK: events outlive purged nodes until compaction
  amplitude  REAL,
  demon_id   TEXT,
  bits       REAL
);
CREATE INDEX events_t ON events (t);

-- Small app state (auto-backup handle reference, checkpoint cache index, …).
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);

-- Semantic layout: 512-d embeddings via sqlite-vec (cosine distance). Load the extension
-- first (sqlite-vec's load()). Embeddings are derived data: not exported, not hashed.
CREATE VIRTUAL TABLE embeddings USING vec0 (
  node_id   TEXT PRIMARY KEY,
  embedding float[512] distance_metric=cosine
);

-- Which text and model produced each embedding, so unchanged nodes are not re-embedded.
CREATE TABLE embedding_meta (
  node_id    TEXT    PRIMARY KEY,
  text_hash  TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
