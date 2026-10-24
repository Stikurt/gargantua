-- Private reader metadata. Devices identify sync streams, never accounts or grants.
CREATE TABLE reader_profiles (
 profile_id uuid PRIMARY KEY REFERENCES profiles(id),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 min_revision bigint NOT NULL DEFAULT 0 CHECK(min_revision >= 0 AND min_revision <= revision)
);
CREATE TABLE reader_devices (
 profile_id uuid NOT NULL REFERENCES profiles(id),device_id uuid NOT NULL,
 last_counter bigint NOT NULL DEFAULT 0 CHECK(last_counter BETWEEN 0 AND 9007199254740991),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(profile_id,device_id)
);
CREATE TABLE reader_entities (
 profile_id uuid NOT NULL REFERENCES profiles(id),
 entity_type text NOT NULL CHECK(entity_type IN ('reading','bookmark','catalog')),
 entity_id uuid NOT NULL,revision integer NOT NULL CHECK(revision >= 0),
 deleted boolean NOT NULL DEFAULT false,payload jsonb,
 legacy_id uuid,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,entity_type,entity_id),
 CHECK(deleted OR payload IS NOT NULL),CHECK(payload IS NULL OR jsonb_typeof(payload)='object'),
 CHECK(legacy_id IS NULL OR entity_type='bookmark')
);
CREATE UNIQUE INDEX reader_legacy_bookmark_identity ON reader_entities(legacy_id) WHERE legacy_id IS NOT NULL;
CREATE TABLE reader_mutations (
 profile_id uuid NOT NULL REFERENCES profiles(id),mutation_id uuid NOT NULL,
 device_id uuid NOT NULL,counter bigint NOT NULL CHECK(counter BETWEEN 1 AND 9007199254740991),
 body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
 canonical_body text NOT NULL CHECK(octet_length(canonical_body)<=131072),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(profile_id,mutation_id),
 UNIQUE(profile_id,device_id,counter),FOREIGN KEY(profile_id,device_id) REFERENCES reader_devices(profile_id,device_id)
);
CREATE TABLE reader_changes (
 profile_id uuid NOT NULL REFERENCES profiles(id),
 change_revision bigint NOT NULL CHECK(change_revision BETWEEN 1 AND 9007199254740991),
 entity_type text NOT NULL CHECK(entity_type IN ('reading','bookmark','catalog')),entity_id uuid NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),PRIMARY KEY(profile_id,change_revision),
 FOREIGN KEY(profile_id,entity_type,entity_id) REFERENCES reader_entities(profile_id,entity_type,entity_id)
);
CREATE INDEX reader_entity_updated ON reader_entities(profile_id,updated_at);
CREATE INDEX reader_mutation_time ON reader_mutations(profile_id,created_at DESC,mutation_id)
 WHERE result->>'status'='conflict';
CREATE INDEX reader_modern_entity_guard ON reader_mutations(profile_id,(body->>'entityType'),(body->>'entityId'))
 WHERE result->>'status'='accepted';

-- Preserve legacy coordinates as explicitly approximate anchors. Scroll ratios
-- cannot prove a text block or character offset and are never upgraded to one.
INSERT INTO reader_profiles(profile_id) SELECT id FROM profiles;
INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,payload)
 SELECT profile_id,'reading',book_id,1,jsonb_build_object(
  'publicationId',book_id,'publicationRevision',1,
  'locator',jsonb_build_object('type','legacy','chapter',chapter,'position',position),'shelf',shelf)
 FROM reading;
INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,payload,legacy_id,updated_at)
 SELECT profile_id,'bookmark',id,1,jsonb_build_object(
  'publicationId',book_id,'publicationRevision',1,
  'locator',jsonb_build_object('type','legacy','chapter',chapter,'position',position),'note',note),id,COALESCE(created_at,now())
 FROM bookmarks;
INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,payload,updated_at)
 SELECT profile_id,'catalog','00000000-0000-4000-8000-000000000002'::uuid,revision,
 jsonb_build_object('catalogs',catalogs),updated_at FROM profile_catalogs;
-- Existing rows belong to snapshot cursor 0. Later writes receive consecutive
-- per-profile revisions in the same transaction as their durable receipt.
