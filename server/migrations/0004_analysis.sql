-- 0004_analysis: two-phase collection/analysis support, dual source heads,
-- and transport-metadata readiness. (0001-0003 are applied history and
-- cannot change; this is how the schema evolves.)

-- analysis is a separate, retryable transaction whose failure must never
-- erase a preserved observation
ALTER TABLE observations ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX observations_analysis_status
ON observations(analysis_status, collected_at);

-- heads distinguish "what happened most recently" from "the last time it
-- worked", so a failing source can still report its last known good state
ALTER TABLE source_heads RENAME COLUMN observation_id TO latest_observation_id;
ALTER TABLE source_heads ADD COLUMN latest_successful_id TEXT REFERENCES observations(id);

-- redirect-aware artifact provenance (transport metadata seam)
ALTER TABLE artifacts ADD COLUMN final_url TEXT;
