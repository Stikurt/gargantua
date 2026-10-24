-- Safe parsed checkpoints live in the dump; untrusted raw input stays in quarantine.
CREATE TABLE ranobe_feeds(
 id uuid PRIMARY KEY,provider text NOT NULL DEFAULT 'ranobelib' CHECK(provider='ranobelib'),
 remote_id text NOT NULL CHECK(remote_id ~ '^[0-9]{1,20}$'),slug text NOT NULL CHECK(slug ~ '^[0-9]+--[a-zA-Z0-9_-]+$'),
 branch_key text NOT NULL CHECK(branch_key ~ '^(default|[0-9]{1,20})$'),language text NOT NULL CHECK(char_length(language) BETWEEN 2 AND 30),
 title text NOT NULL DEFAULT '',author text NOT NULL DEFAULT '',requested_by uuid NOT NULL REFERENCES profiles(id),approved_by uuid REFERENCES profiles(id),
 auto_update boolean NOT NULL DEFAULT false,update_interval_hours integer NOT NULL DEFAULT 6 CHECK(update_interval_hours BETWEEN 6 AND 168),
 next_check_at timestamptz NOT NULL DEFAULT now()+interval '6 hours',revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 active_import_id uuid UNIQUE REFERENCES imports(id),head_run_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,remote_id,branch_key,language)
);
CREATE TABLE ranobe_feed_requests(
 id uuid PRIMARY KEY,feed_id uuid NOT NULL REFERENCES ranobe_feeds(id),profile_id uuid NOT NULL REFERENCES profiles(id),
 idempotency_key uuid NOT NULL,body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),import_id uuid NOT NULL REFERENCES imports(id),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(profile_id,idempotency_key)
);
CREATE TABLE ranobe_runs(
 id uuid PRIMARY KEY,feed_id uuid NOT NULL REFERENCES ranobe_feeds(id),import_id uuid NOT NULL UNIQUE REFERENCES imports(id),
 previous_head_id uuid,inventory_sha256 text NOT NULL CHECK(inventory_sha256 ~ '^[a-f0-9]{64}$'),chapter_count integer NOT NULL CHECK(chapter_count BETWEEN 1 AND 20000),
 policy_version text NOT NULL CHECK(char_length(policy_version) BETWEEN 1 AND 120),force_revalidate boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'building' CHECK(status IN('building','ready','abandoned')),
 created_at timestamptz NOT NULL DEFAULT now(),activated_at timestamptz,UNIQUE(id,feed_id),
 CHECK((status='ready')=(activated_at IS NOT NULL))
);
ALTER TABLE ranobe_feeds ADD CONSTRAINT ranobe_head_same_feed FOREIGN KEY(head_run_id,id) REFERENCES ranobe_runs(id,feed_id);
ALTER TABLE ranobe_runs ADD CONSTRAINT ranobe_previous_same_feed FOREIGN KEY(previous_head_id,feed_id) REFERENCES ranobe_runs(id,feed_id);
CREATE UNIQUE INDEX ranobe_one_building_run ON ranobe_runs(feed_id) WHERE status='building';
CREATE TABLE ranobe_chapters(
 id uuid PRIMARY KEY,feed_id uuid NOT NULL REFERENCES ranobe_feeds(id),source_key text NOT NULL CHECK(char_length(source_key) BETWEEN 1 AND 180),
 revision_hint text NOT NULL CHECK(char_length(revision_hint)<=200),policy_version text NOT NULL CHECK(char_length(policy_version) BETWEEN 1 AND 120),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[a-f0-9]{64}$'),content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 prepared_book jsonb,prepared_bytes integer NOT NULL CHECK(prepared_bytes BETWEEN 1 AND 20971520),
 scanner_version text NOT NULL CHECK(char_length(scanner_version) BETWEEN 1 AND 300),parser_version text NOT NULL CHECK(char_length(parser_version) BETWEEN 1 AND 120),
 book_id uuid REFERENCES books(id),chapter_index integer CHECK(chapter_index BETWEEN 0 AND 999),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(feed_id,source_key,revision_hint,policy_version,content_sha256),UNIQUE(id,feed_id),
 CHECK((prepared_book IS NOT NULL AND book_id IS NULL AND chapter_index IS NULL) OR (prepared_book IS NULL AND book_id IS NOT NULL AND chapter_index IS NOT NULL)),
 CHECK(prepared_book IS NULL OR (jsonb_typeof(prepared_book)='object' AND octet_length(prepared_book::text)<=22020096))
);
CREATE TABLE ranobe_run_chapters(
 run_id uuid NOT NULL,feed_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 19999),
 source_key text NOT NULL CHECK(char_length(source_key) BETWEEN 1 AND 180),revision_hint text NOT NULL CHECK(char_length(revision_hint)<=200),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=2048),chapter_id uuid,
 PRIMARY KEY(run_id,ordinal),UNIQUE(run_id,source_key),FOREIGN KEY(run_id,feed_id) REFERENCES ranobe_runs(id,feed_id),
 FOREIGN KEY(chapter_id,feed_id) REFERENCES ranobe_chapters(id,feed_id)
);
CREATE TABLE ranobe_run_parts(
 id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES ranobe_runs(id),ordinal integer NOT NULL CHECK(ordinal>=0),
 keys_sha256 text NOT NULL CHECK(keys_sha256 ~ '^[a-f0-9]{64}$'),source_keys jsonb NOT NULL CHECK(jsonb_typeof(source_keys)='array' AND jsonb_array_length(source_keys) BETWEEN 1 AND 50 AND octet_length(source_keys::text)<=10240),
 import_id uuid NOT NULL UNIQUE REFERENCES imports(id),book_id uuid REFERENCES books(id),package_sha256 text CHECK(package_sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'building' CHECK(status IN('building','ready')),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,ordinal),UNIQUE(run_id,keys_sha256),CHECK((status='ready')=(book_id IS NOT NULL AND package_sha256 IS NOT NULL))
);
CREATE INDEX ranobe_chapters_lookup ON ranobe_chapters(feed_id,source_key,revision_hint,policy_version);
CREATE INDEX ranobe_feed_due ON ranobe_feeds(next_check_at) WHERE auto_update;
CREATE INDEX ranobe_feed_requests_actor ON ranobe_feed_requests(profile_id,created_at DESC);
CREATE TABLE ranobe_scratch(
 token uuid PRIMARY KEY,parent_attempt uuid NOT NULL REFERENCES import_attempts(token),run_id uuid NOT NULL REFERENCES ranobe_runs(id),
 source_key text NOT NULL CHECK(char_length(source_key) BETWEEN 1 AND 180),raw_sha256 text CHECK(raw_sha256 ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ranobe_scratch_parent ON ranobe_scratch(parent_attempt);
CREATE FUNCTION protect_ranobe_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN RAISE EXCEPTION 'Snapshot membership cannot move'; END IF;
 SELECT status INTO run_status FROM ranobe_runs WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.run_id ELSE NEW.run_id END FOR SHARE;
 IF run_status='ready' THEN RAISE EXCEPTION 'Activated source snapshot is immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER ranobe_snapshot_chapters_immutable BEFORE INSERT OR UPDATE OR DELETE ON ranobe_run_chapters FOR EACH ROW EXECUTE FUNCTION protect_ranobe_snapshot();
CREATE TRIGGER ranobe_snapshot_parts_immutable BEFORE INSERT OR UPDATE OR DELETE ON ranobe_run_parts FOR EACH ROW EXECUTE FUNCTION protect_ranobe_snapshot();
CREATE FUNCTION protect_ranobe_ready_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='ready' THEN RAISE EXCEPTION 'Activated source snapshot is immutable'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.feed_id,NEW.import_id,NEW.previous_head_id,NEW.inventory_sha256,NEW.chapter_count,NEW.policy_version,NEW.force_revalidate) IS DISTINCT FROM
 (OLD.id,OLD.feed_id,OLD.import_id,OLD.previous_head_id,OLD.inventory_sha256,OLD.chapter_count,OLD.policy_version,OLD.force_revalidate) THEN RAISE EXCEPTION 'Source inventory is immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER ranobe_ready_run_immutable BEFORE UPDATE OR DELETE ON ranobe_runs FOR EACH ROW EXECUTE FUNCTION protect_ranobe_ready_run();
CREATE FUNCTION protect_ranobe_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.feed_id,NEW.source_key,NEW.revision_hint,NEW.policy_version,NEW.raw_sha256,NEW.content_sha256,NEW.prepared_bytes,NEW.scanner_version,NEW.parser_version) IS DISTINCT FROM
    (OLD.id,OLD.feed_id,OLD.source_key,OLD.revision_hint,OLD.policy_version,OLD.raw_sha256,OLD.content_sha256,OLD.prepared_bytes,OLD.scanner_version,OLD.parser_version) OR
    (OLD.prepared_book IS NULL AND (NEW.book_id,NEW.chapter_index,NEW.prepared_book) IS DISTINCT FROM (OLD.book_id,OLD.chapter_index,OLD.prepared_book)) OR
    (OLD.prepared_book IS NOT NULL AND NEW.prepared_book IS NOT NULL AND NEW.prepared_book IS DISTINCT FROM OLD.prepared_book)
 THEN RAISE EXCEPTION 'Verified checkpoint content and published pointers are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ranobe_checkpoint_immutable BEFORE UPDATE ON ranobe_chapters FOR EACH ROW EXECUTE FUNCTION protect_ranobe_checkpoint();
