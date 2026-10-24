CREATE TABLE works(
 id uuid PRIMARY KEY, title text NOT NULL, authors jsonb NOT NULL DEFAULT '[]',
 identity_state text NOT NULL DEFAULT 'unverified' CHECK(identity_state IN('unverified','source-bound','owner-confirmed')),
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(jsonb_typeof(authors)='array')
);
CREATE TABLE work_sources(
 provider text NOT NULL, remote_id text NOT NULL, work_id uuid NOT NULL REFERENCES works(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(provider,remote_id)
);
CREATE TABLE expressions(
 id uuid PRIMARY KEY, work_id uuid NOT NULL REFERENCES works(id),language text NOT NULL,
 kind text NOT NULL CHECK(kind IN('unclassified','original','human-translation','machine-translation')),
 variant_key text NOT NULL, label text NOT NULL DEFAULT '',source_expression_id uuid REFERENCES expressions(id),
 recipe jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(work_id,variant_key),UNIQUE(id,work_id),CHECK(source_expression_id IS DISTINCT FROM id)
);
CREATE TABLE editions(
 id uuid PRIMARY KEY,expression_id uuid NOT NULL REFERENCES expressions(id),source_kind text NOT NULL,
 external_ids jsonb NOT NULL DEFAULT '{}',coverage jsonb NOT NULL DEFAULT '{"kind":"unknown"}',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,expression_id)
);
ALTER TABLE expressions ADD CONSTRAINT expressions_source_same_work FOREIGN KEY(source_expression_id,work_id) REFERENCES expressions(id,work_id);
ALTER TABLE expressions ADD CONSTRAINT machine_translation_has_source CHECK(kind<>'machine-translation' OR source_expression_id IS NOT NULL);
ALTER TABLE books ADD COLUMN work_id uuid REFERENCES works(id);
ALTER TABLE books ADD COLUMN expression_id uuid;
ALTER TABLE books ADD COLUMN edition_id uuid;
ALTER TABLE books ADD COLUMN publication_manifest jsonb;
ALTER TABLE books ADD COLUMN publication_sha256 text;
ALTER TABLE books ADD CONSTRAINT books_expression_work FOREIGN KEY(expression_id,work_id) REFERENCES expressions(id,work_id);
ALTER TABLE books ADD CONSTRAINT books_edition_expression FOREIGN KEY(edition_id,expression_id) REFERENCES editions(id,expression_id);
DO $$ DECLARE b record; w uuid; e uuid; d uuid; BEGIN
 FOR b IN SELECT id,title,author,language FROM books ORDER BY id LOOP
  w:=gen_random_uuid();e:=gen_random_uuid();d:=gen_random_uuid();
  INSERT INTO works(id,title,authors) VALUES(w,b.title,CASE WHEN b.author='' THEN '[]'::jsonb ELSE jsonb_build_array(b.author) END);
  INSERT INTO expressions(id,work_id,language,kind,variant_key) VALUES(e,w,CASE WHEN b.language='' THEN 'und' ELSE b.language END,'unclassified','legacy:'||b.id);
  INSERT INTO editions(id,expression_id,source_kind) VALUES(d,e,'legacy');
  UPDATE books SET work_id=w,expression_id=e,edition_id=d WHERE id=b.id;
 END LOOP;
END $$;
ALTER TABLE books ALTER COLUMN work_id SET NOT NULL;
ALTER TABLE books ALTER COLUMN expression_id SET NOT NULL;
ALTER TABLE books ALTER COLUMN edition_id SET NOT NULL;
ALTER TABLE books ADD CONSTRAINT books_publication_metadata_complete CHECK(
 (publication_manifest IS NULL AND publication_sha256 IS NULL) OR
 (publication_manifest IS NOT NULL AND publication_sha256 IS NOT NULL AND jsonb_typeof(publication_manifest)='object' AND publication_sha256 ~ '^[a-f0-9]{64}$')
);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM books WHERE content_sha256 IS NOT NULL GROUP BY content_sha256 HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Duplicate prepared content: owner review required before migration';
 END IF;
END $$;
CREATE UNIQUE INDEX books_one_exact_content ON books(content_sha256) WHERE content_sha256 IS NOT NULL;
ALTER TABLE import_attempts DROP CONSTRAINT import_attempts_state_check;
ALTER TABLE import_attempts ADD CONSTRAINT import_attempts_state_check CHECK(state IN('running','prepared','placed','published','reused','failed','interrupted','cleaned'));
ALTER TABLE import_attempts ADD COLUMN reused_book_id uuid REFERENCES books(id);
CREATE FUNCTION protect_publication_bytes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.artifact_manifest IS NOT NULL AND (NEW.id,NEW.import_id,NEW.sha256,NEW.content_sha256,NEW.content_bytes,NEW.package_sha256,NEW.artifact_manifest,NEW.title,NEW.author,NEW.language,NEW.chapter_count) IS DISTINCT FROM (OLD.id,OLD.import_id,OLD.sha256,OLD.content_sha256,OLD.content_bytes,OLD.package_sha256,OLD.artifact_manifest,OLD.title,OLD.author,OLD.language,OLD.chapter_count) THEN
  RAISE EXCEPTION 'Published bytes and their identity are immutable';
 END IF;
 IF OLD.publication_manifest IS NOT NULL AND (NEW.work_id,NEW.expression_id,NEW.edition_id,NEW.publication_manifest,NEW.publication_sha256) IS DISTINCT FROM (OLD.work_id,OLD.expression_id,OLD.edition_id,OLD.publication_manifest,OLD.publication_sha256) THEN
  RAISE EXCEPTION 'Publication revision is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER books_immutable BEFORE UPDATE ON books FOR EACH ROW EXECUTE FUNCTION protect_publication_bytes();
