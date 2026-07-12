-- 0002_evidence: relationships, evidence, findings, and their join tables.

CREATE TABLE entity_relationships (
    source_entity_id     TEXT NOT NULL,
    target_entity_id     TEXT NOT NULL,
    relationship_type    TEXT NOT NULL,
    first_seen_at        TEXT NOT NULL,
    last_seen_at         TEXT NOT NULL,
    confidence           REAL,
    basis_json           TEXT,
    metadata_json        TEXT,
    PRIMARY KEY (source_entity_id, target_entity_id, relationship_type),
    FOREIGN KEY (source_entity_id) REFERENCES entities(id),
    FOREIGN KEY (target_entity_id) REFERENCES entities(id)
);

CREATE TABLE evidence (
    id                  TEXT PRIMARY KEY,
    evidence_type       TEXT NOT NULL,
    authority           TEXT,
    external_id         TEXT,
    canonical_url       TEXT,
    published_at        TEXT,
    modified_at         TEXT,
    content_digest      TEXT,
    artifact_digest     TEXT,
    evidence_json       TEXT NOT NULL,
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    FOREIGN KEY (artifact_digest) REFERENCES artifacts(digest)
);

CREATE TABLE entity_evidence (
    entity_id            TEXT NOT NULL,
    evidence_id          TEXT NOT NULL,
    relationship_type    TEXT NOT NULL,
    confidence           REAL,
    basis_json           TEXT,
    PRIMARY KEY (entity_id, evidence_id, relationship_type)
);

CREATE TABLE change_evidence (
    change_id            TEXT NOT NULL,
    evidence_id          TEXT NOT NULL,
    relationship_type    TEXT NOT NULL,
    confidence           REAL,
    basis_json           TEXT,
    PRIMARY KEY (change_id, evidence_id, relationship_type)
);

CREATE TABLE findings (
    id                   TEXT PRIMARY KEY,
    rule_id              TEXT NOT NULL,
    rule_version         TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    confidence           REAL,
    confidence_basis     TEXT,
    finding_type         TEXT NOT NULL,
    summary              TEXT NOT NULL,
    evidence_json        TEXT NOT NULL,
    counterevidence_json TEXT,
    ambiguity_json       TEXT,
    metadata_json        TEXT
);
