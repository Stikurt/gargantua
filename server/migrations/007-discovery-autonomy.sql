-- Retry clocks survive worker/host restarts. Acquisition keys identify an exact
-- selected source file, never a normalized title or a guessed work identity.
ALTER TABLE discovery_requests
 ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 3),
 ADD COLUMN next_attempt_at timestamptz,
 ADD COLUMN acquisition_key text CHECK(acquisition_key IS NULL OR acquisition_key ~ '^[a-f0-9]{64}$');
CREATE INDEX discovery_requests_due ON discovery_requests(status,next_attempt_at,updated_at)
 WHERE status IN('queued','selected','processing');
CREATE INDEX discovery_requests_acquisition_key ON discovery_requests(acquisition_key)
 WHERE acquisition_key IS NOT NULL AND import_id IS NOT NULL;
