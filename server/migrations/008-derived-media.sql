-- Model output is a separate derivative. Source publications and book bytes are
-- never overwritten, even when a recipe or an original later changes.
ALTER TABLE books ADD CONSTRAINT books_derived_model_key UNIQUE(id,expression_id,edition_id);
CREATE TABLE derived_recipes(
 sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN('translation','audio')),language text NOT NULL CHECK(language ~ '^[a-z]{2,8}(-[A-Za-z0-9]{1,8})*$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(sha256,kind)
);
CREATE TABLE derived_sources(
 sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),work_id uuid NOT NULL REFERENCES works(id),expression_id uuid NOT NULL,
 snapshot_id uuid REFERENCES ranobe_runs(id),manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=16777216),
 created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(expression_id,work_id) REFERENCES expressions(id,work_id),UNIQUE(sha256,work_id,expression_id),UNIQUE(sha256,expression_id)
);
CREATE TABLE derived_source_parts(
 source_sha256 text NOT NULL REFERENCES derived_sources(sha256),ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 19999),
 book_id uuid NOT NULL REFERENCES books(id),expression_id uuid NOT NULL,edition_id uuid NOT NULL,
 publication_sha256 text NOT NULL CHECK(publication_sha256 ~ '^[a-f0-9]{64}$'),package_sha256 text NOT NULL CHECK(package_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(source_sha256,ordinal),UNIQUE(source_sha256,book_id),FOREIGN KEY(edition_id,expression_id) REFERENCES editions(id,expression_id),
 FOREIGN KEY(book_id,expression_id,edition_id) REFERENCES books(id,expression_id,edition_id),
 FOREIGN KEY(source_sha256,expression_id) REFERENCES derived_sources(sha256,expression_id)
);
CREATE TABLE derived_jobs(
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('translation','audio')),source_sha256 text NOT NULL REFERENCES derived_sources(sha256),
 recipe_sha256 text NOT NULL,FOREIGN KEY(recipe_sha256,kind) REFERENCES derived_recipes(sha256,kind),
 status text NOT NULL CHECK(status IN('queued','processing','paused','approval-required','completed','failed','cancelled','blocked')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),attempt_number integer NOT NULL DEFAULT 0 CHECK(attempt_number>=0),attempt_token uuid,lease_expires_at timestamptz,
 plan_sha256 text CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),plan jsonb CHECK(plan IS NULL OR (jsonb_typeof(plan)='object' AND octet_length(plan::text)<=16777216)),
 total_segments integer CHECK(total_segments BETWEEN 1 AND 50000),completed_segments integer NOT NULL DEFAULT 0 CHECK(completed_segments>=0),
 pause_reason text CHECK(char_length(pause_reason)<=120),next_attempt_at timestamptz,error text CHECK(char_length(error)<=600),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(kind,source_sha256,recipe_sha256),CHECK((plan IS NULL AND plan_sha256 IS NULL AND total_segments IS NULL AND completed_segments=0) OR (plan IS NOT NULL AND plan_sha256 IS NOT NULL AND total_segments IS NOT NULL AND completed_segments<=total_segments)),
 CHECK(status<>'processing' OR (attempt_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
-- The host executor also shares the existing import resource reservation. This
-- database guard prevents two derivative claims from using the same heavy slot.
CREATE UNIQUE INDEX derived_one_processing ON derived_jobs((true)) WHERE status='processing';
CREATE TABLE derived_requests(
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES derived_jobs(id),requested_by uuid NOT NULL REFERENCES profiles(id),
 discovery_request_id uuid REFERENCES discovery_requests(id),parent_job_id uuid REFERENCES derived_jobs(id),parent_request_id uuid,audio_requested boolean NOT NULL DEFAULT false,
 status text NOT NULL CHECK(status IN('pending-approval','active','completed','cancelled')),
 approved_by uuid REFERENCES profiles(id),decision_reason text CHECK(decision_reason IN('role-auto-approval','owner-approval')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,requested_by),UNIQUE(id,job_id,requested_by),FOREIGN KEY(parent_request_id,parent_job_id,requested_by) REFERENCES derived_requests(id,job_id,requested_by),
 CHECK((parent_job_id IS NULL)=(parent_request_id IS NULL)),CHECK(status NOT IN('active','completed') OR (approved_by IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE TABLE derived_idempotency(
 profile_id uuid NOT NULL REFERENCES profiles(id),key uuid NOT NULL,body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(profile_id,key),
 FOREIGN KEY(request_id,profile_id) REFERENCES derived_requests(id,requested_by)
);
CREATE TABLE derived_attempts(
 token uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES derived_jobs(id),number integer NOT NULL CHECK(number>0),
 state text NOT NULL CHECK(state IN('running','finished','failed','interrupted','paused','cancelled')),
 error text CHECK(char_length(error)<=600),started_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,
 UNIQUE(job_id,number),UNIQUE(token,job_id)
);
ALTER TABLE derived_jobs ADD CONSTRAINT derived_attempt_owner FOREIGN KEY(attempt_token,id) REFERENCES derived_attempts(token,job_id);
CREATE TABLE derived_checkpoints(
 job_id uuid NOT NULL REFERENCES derived_jobs(id),ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 49999),attempt_token uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),output_sha256 text NOT NULL CHECK(output_sha256 ~ '^[a-f0-9]{64}$'),
 output_bytes bigint NOT NULL CHECK(output_bytes BETWEEN 1 AND 33554432),manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id,ordinal),FOREIGN KEY(attempt_token,job_id) REFERENCES derived_attempts(token,job_id)
);
CREATE TABLE derived_results(
 job_id uuid PRIMARY KEY REFERENCES derived_jobs(id),work_id uuid NOT NULL REFERENCES works(id),expression_id uuid NOT NULL,edition_id uuid NOT NULL,
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=16777216),sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 bytes bigint NOT NULL CHECK(bytes>0),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(expression_id,work_id) REFERENCES expressions(id,work_id),FOREIGN KEY(edition_id,expression_id) REFERENCES editions(id,expression_id)
);
CREATE INDEX derived_requests_actor ON derived_requests(requested_by,created_at DESC);
CREATE INDEX derived_requests_job ON derived_requests(job_id,status);
CREATE INDEX derived_jobs_due ON derived_jobs(status,next_attempt_at,updated_at);
CREATE FUNCTION protect_derived_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Derived source, recipe, checkpoint and result identities are immutable';
END $$;
CREATE TRIGGER derived_recipes_immutable BEFORE UPDATE OR DELETE ON derived_recipes FOR EACH ROW EXECUTE FUNCTION protect_derived_immutable();
CREATE TRIGGER derived_sources_immutable BEFORE UPDATE OR DELETE ON derived_sources FOR EACH ROW EXECUTE FUNCTION protect_derived_immutable();
CREATE TRIGGER derived_source_parts_immutable BEFORE UPDATE OR DELETE ON derived_source_parts FOR EACH ROW EXECUTE FUNCTION protect_derived_immutable();
CREATE TRIGGER derived_checkpoints_immutable BEFORE UPDATE OR DELETE ON derived_checkpoints FOR EACH ROW EXECUTE FUNCTION protect_derived_immutable();
CREATE TRIGGER derived_results_immutable BEFORE UPDATE OR DELETE ON derived_results FOR EACH ROW EXECUTE FUNCTION protect_derived_immutable();
CREATE FUNCTION protect_derived_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.kind,NEW.source_sha256,NEW.recipe_sha256) IS DISTINCT FROM (OLD.id,OLD.kind,OLD.source_sha256,OLD.recipe_sha256) OR
 (OLD.plan IS NOT NULL AND (NEW.plan,NEW.plan_sha256,NEW.total_segments) IS DISTINCT FROM (OLD.plan,OLD.plan_sha256,OLD.total_segments)) OR
 NEW.completed_segments<OLD.completed_segments OR OLD.status='completed' AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'Derived job identity, committed plan and completed result are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER derived_jobs_identity_immutable BEFORE UPDATE ON derived_jobs FOR EACH ROW EXECUTE FUNCTION protect_derived_job_identity();
