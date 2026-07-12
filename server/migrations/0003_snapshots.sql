-- 0003_snapshots: snapshot manifests, content joins, and the import ledger.

CREATE TABLE snapshots (
    id                   TEXT PRIMARY KEY,
    schema_version       TEXT NOT NULL,
    window_start         TEXT NOT NULL,
    window_end           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    scope_json           TEXT NOT NULL,
    truth_boundary_json  TEXT NOT NULL,
    content_digest       TEXT NOT NULL,
    bundle_path          TEXT,
    metadata_json        TEXT
);

CREATE TABLE snapshot_observations (
    snapshot_id      TEXT NOT NULL,
    observation_id   TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, observation_id)
);

CREATE TABLE snapshot_changes (
    snapshot_id      TEXT NOT NULL,
    change_id        TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, change_id)
);

CREATE TABLE snapshot_findings (
    snapshot_id      TEXT NOT NULL,
    finding_id       TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, finding_id)
);

CREATE TABLE imports (
    id               TEXT PRIMARY KEY,
    imported_at      TEXT NOT NULL,
    source_path      TEXT NOT NULL,
    manifest_json    TEXT NOT NULL,
    dry_run          INTEGER NOT NULL,
    inserted_json    TEXT NOT NULL,
    conflicts_json   TEXT NOT NULL
);
