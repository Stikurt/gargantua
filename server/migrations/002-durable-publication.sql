-- Existing rows are preserved. Legacy publications need an explicit scanned seal.
ALTER TABLE books ADD COLUMN content_sha256 text;
ALTER TABLE books ADD COLUMN content_bytes bigint;
ALTER TABLE books ADD COLUMN package_sha256 text;
ALTER TABLE books ADD COLUMN artifact_manifest jsonb;
ALTER TABLE imports ADD COLUMN attempt_number int NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN attempt_token uuid;
ALTER TABLE imports ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE imports ADD COLUMN cleanup_pending boolean NOT NULL DEFAULT false;
ALTER TABLE imports ADD COLUMN cleanup_error text;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM books GROUP BY import_id HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Duplicate import publications: owner review required before migration';
 END IF;
END $$;
CREATE UNIQUE INDEX books_one_result_per_import ON books(import_id);
CREATE TABLE import_attempts(
 token uuid PRIMARY KEY,
 import_id uuid NOT NULL REFERENCES imports(id),
 number int NOT NULL,
 book_id uuid NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('running','prepared','placed','published','failed','interrupted','cleaned')),
 artifact_manifest jsonb,
 error text,
 cleanup_error text,
 cleanup_checked_at timestamptz,
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 UNIQUE(import_id,number)
);
CREATE INDEX import_attempts_reconcile ON import_attempts(state);
CREATE INDEX imports_lease ON imports(lease_expires_at) WHERE status='processing';
ALTER TABLE books ADD CONSTRAINT books_prepared_metadata_complete CHECK(
 (artifact_manifest IS NULL AND content_sha256 IS NULL AND content_bytes IS NULL AND package_sha256 IS NULL)
 OR (artifact_manifest IS NOT NULL AND content_sha256 IS NOT NULL AND content_bytes IS NOT NULL AND package_sha256 IS NOT NULL
     AND jsonb_typeof(artifact_manifest)='object' AND content_sha256 ~ '^[a-f0-9]{64}$' AND content_bytes>0 AND package_sha256 ~ '^[a-f0-9]{64}$')
);
