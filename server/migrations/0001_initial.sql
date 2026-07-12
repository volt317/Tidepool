-- 0001_initial: sources, artifacts, observations, heads, entities, states, changes.
-- Timestamps are ISO-8601 UTC TEXT. Digests are lowercase hex sha256.

CREATE TABLE sources (
    id                    TEXT PRIMARY KEY,
    domain                TEXT NOT NULL,
    unit_id               TEXT NOT NULL,
    source_type           TEXT NOT NULL,
    authority             TEXT,
    canonical_url         TEXT,
    configuration_json    TEXT NOT NULL,
    configuration_digest  TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    metadata_json         TEXT
);

CREATE UNIQUE INDEX sources_identity ON sources(domain, unit_id, source_type);

CREATE TABLE artifacts (
    digest            TEXT PRIMARY KEY,
    algorithm         TEXT NOT NULL DEFAULT 'sha256',
    media_type        TEXT,
    compression       TEXT,
    byte_size         INTEGER,
    storage_path      TEXT,
    fetched_url       TEXT,
    etag              TEXT,
    last_modified     TEXT,
    created_at        TEXT NOT NULL,
    metadata_json     TEXT
);

CREATE TABLE observations (
    id                       TEXT PRIMARY KEY,
    source_id                TEXT NOT NULL,
    collected_at             TEXT NOT NULL,
    fetch_started_at         TEXT,
    fetch_finished_at        TEXT,
    status                   TEXT NOT NULL,
    artifact_digest          TEXT,
    normalized_digest        TEXT,
    verification_level       TEXT,
    signer_fingerprint       TEXT,
    verification_json        TEXT,
    coverage_complete        INTEGER,
    coverage_json            TEXT,
    parser_name              TEXT,
    parser_version           TEXT,
    config_digest            TEXT,
    error_json               TEXT,
    metadata_json            TEXT,
    FOREIGN KEY (source_id) REFERENCES sources(id),
    FOREIGN KEY (artifact_digest) REFERENCES artifacts(digest)
);

CREATE INDEX observations_source_time ON observations(source_id, collected_at);
CREATE INDEX observations_status_time ON observations(status, collected_at);

CREATE TABLE source_heads (
    source_id         TEXT PRIMARY KEY,
    observation_id    TEXT NOT NULL,
    collected_at      TEXT NOT NULL,
    normalized_digest TEXT,
    status            TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES sources(id),
    FOREIGN KEY (observation_id) REFERENCES observations(id)
);

CREATE TABLE entities (
    id                TEXT PRIMARY KEY,
    domain            TEXT NOT NULL,
    ecosystem         TEXT NOT NULL,
    entity_type       TEXT NOT NULL,
    canonical_name    TEXT NOT NULL,
    namespace         TEXT,
    architecture      TEXT,
    identity_json     TEXT NOT NULL,
    first_seen_at     TEXT NOT NULL,
    last_seen_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX entities_canonical_identity
ON entities(domain, ecosystem, entity_type, canonical_name,
            COALESCE(namespace,''), COALESCE(architecture,''));

CREATE TABLE entity_states (
    id                  TEXT PRIMARY KEY,
    entity_id           TEXT NOT NULL,
    observation_id      TEXT NOT NULL,
    version             TEXT,
    source_package      TEXT,
    repository          TEXT,
    channel             TEXT,
    component           TEXT,
    section             TEXT,
    architecture        TEXT,
    state_digest        TEXT NOT NULL,
    state_json          TEXT NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(id),
    FOREIGN KEY (observation_id) REFERENCES observations(id),
    UNIQUE(entity_id, observation_id)
);

CREATE INDEX entity_states_entity ON entity_states(entity_id);
CREATE INDEX entity_states_observation ON entity_states(observation_id);
CREATE INDEX entity_states_version ON entity_states(version);

CREATE TABLE changes (
    id                        TEXT PRIMARY KEY,
    domain                    TEXT NOT NULL,
    unit_id                   TEXT NOT NULL,
    source_id                 TEXT NOT NULL,
    entity_id                 TEXT,
    previous_observation_id   TEXT,
    current_observation_id    TEXT NOT NULL,
    change_type               TEXT NOT NULL,
    detected_at               TEXT NOT NULL,
    previous_state_digest     TEXT,
    current_state_digest      TEXT,
    details_json              TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES sources(id),
    FOREIGN KEY (entity_id) REFERENCES entities(id),
    FOREIGN KEY (previous_observation_id) REFERENCES observations(id),
    FOREIGN KEY (current_observation_id) REFERENCES observations(id)
);

CREATE INDEX changes_detected_at ON changes(detected_at);
CREATE INDEX changes_entity_time ON changes(entity_id, detected_at);
CREATE INDEX changes_type_time ON changes(change_type, detected_at);
CREATE INDEX changes_source_time ON changes(source_id, detected_at);
