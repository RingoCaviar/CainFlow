CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '1');
CREATE TABLE documents (name TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO documents VALUES ('session', '{"workflows":[]}', 1);
CREATE TABLE assets (
  asset_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, relative_path TEXT NOT NULL, created_at INTEGER NOT NULL
);
INSERT INTO assets VALUES ('legacy:fixture', '00', 'node', 'application/octet-stream', 1, 'legacy.bin', 1);
