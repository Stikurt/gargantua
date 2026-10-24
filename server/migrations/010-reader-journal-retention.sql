-- Receipt identities survive v1 compaction. V2 identities bind the profile,
-- device and counter, so a permanent device fence safely replaces old accepts.
ALTER TABLE reader_entities ADD COLUMN modern_write boolean NOT NULL DEFAULT false;
UPDATE reader_entities e SET modern_write=true WHERE EXISTS (
 SELECT 1 FROM reader_mutations m WHERE m.profile_id=e.profile_id
 AND m.body->>'entityType'=e.entity_type AND (m.body->>'entityId')::uuid=e.entity_id
 AND m.result->>'status'='accepted');
ALTER TABLE reader_devices ADD COLUMN protocol_version integer NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2));
ALTER TABLE reader_devices ADD COLUMN compacted_through bigint NOT NULL DEFAULT 0 CHECK(compacted_through BETWEEN 0 AND last_counter);
ALTER TABLE reader_devices ADD COLUMN compacted_accepted bigint NOT NULL DEFAULT 0 CHECK(compacted_accepted BETWEEN 0 AND compacted_through);
ALTER TABLE reader_devices ADD COLUMN compaction_sha256 text;
ALTER TABLE reader_devices ADD CONSTRAINT reader_device_compaction CHECK(
 (compacted_accepted=0 AND compacted_through=0 AND compaction_sha256 IS NULL)
 OR (protocol_version=2 AND compacted_accepted>0 AND compaction_sha256 ~ '^[a-f0-9]{64}$'));
ALTER TABLE reader_mutations ADD COLUMN compacted boolean NOT NULL DEFAULT false;
ALTER TABLE reader_mutations ADD COLUMN entity_type text;
ALTER TABLE reader_mutations ADD COLUMN entity_id uuid;
ALTER TABLE reader_mutations ADD COLUMN accepted_revision integer;
UPDATE reader_mutations SET entity_type=body->>'entityType',entity_id=(body->>'entityId')::uuid,
 accepted_revision=CASE WHEN result->>'status'='accepted' THEN (result->'entity'->>'revision')::integer END;
ALTER TABLE reader_mutations ALTER COLUMN entity_type SET NOT NULL;
ALTER TABLE reader_mutations ALTER COLUMN entity_id SET NOT NULL;
ALTER TABLE reader_mutations ALTER COLUMN body DROP NOT NULL;
ALTER TABLE reader_mutations ALTER COLUMN canonical_body DROP NOT NULL;
ALTER TABLE reader_mutations ADD CONSTRAINT reader_receipt_retention CHECK(
 entity_type IN ('reading','bookmark','catalog') AND
 ((result->>'status'='accepted' AND accepted_revision BETWEEN 1 AND 2147483647)
  OR (result->>'status'='conflict' AND accepted_revision IS NULL AND NOT compacted)) AND
 ((compacted AND body IS NULL AND canonical_body IS NULL AND result->>'status'='accepted')
  OR (NOT compacted AND body IS NOT NULL AND canonical_body IS NOT NULL)));
DROP INDEX reader_modern_entity_guard;
CREATE INDEX reader_full_accepted_retention ON reader_mutations(profile_id,created_at DESC,mutation_id)
 WHERE result->>'status'='accepted' AND NOT compacted;

-- Exact wire-byte accounting shares the backup JSONL format. These lower
-- admission limits reserve room below backup's 128 MiB / 500,000-line bound.
CREATE TABLE reader_journal_budget (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 rows bigint NOT NULL CHECK(rows>=0),
 bytes bigint NOT NULL CHECK(bytes>=0)
);
CREATE FUNCTION reader_journal_row_bytes(table_name text,record jsonb) RETURNS bigint
 LANGUAGE sql IMMUTABLE AS $$
 SELECT octet_length(json_build_object('table',table_name,'row',record)::text)::bigint+1
$$;
CREATE FUNCTION reader_journal_measure() RETURNS TABLE(rows bigint,bytes bigint)
 LANGUAGE sql STABLE SET TimeZone='UTC' SET DateStyle='ISO, YMD' AS $$
 SELECT count(*)::bigint,COALESCE(sum(size),0)::bigint FROM (
 SELECT reader_journal_row_bytes('reader_profiles',to_jsonb(t)) size FROM reader_profiles t
 UNION ALL SELECT reader_journal_row_bytes('reader_devices',to_jsonb(t)) FROM reader_devices t
 UNION ALL SELECT reader_journal_row_bytes('reader_entities',to_jsonb(t)) FROM reader_entities t
 UNION ALL SELECT reader_journal_row_bytes('reader_mutations',to_jsonb(t)) FROM reader_mutations t
 UNION ALL SELECT reader_journal_row_bytes('reader_changes',to_jsonb(t)) FROM reader_changes t
 ) measured
$$;
INSERT INTO reader_journal_budget(singleton,rows,bytes) SELECT true,rows,bytes FROM reader_journal_measure();
CREATE FUNCTION reader_journal_account() RETURNS trigger LANGUAGE plpgsql
 SET TimeZone='UTC' SET DateStyle='ISO, YMD' AS $$
DECLARE row_delta bigint:=0;byte_delta bigint:=0;current_rows bigint;current_bytes bigint;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  UPDATE reader_journal_budget SET (rows,bytes)=(SELECT rows,bytes FROM reader_journal_measure()) WHERE singleton;
  RETURN NULL;
 END IF;
 IF TG_OP IN ('UPDATE','DELETE') THEN row_delta:=row_delta-1;byte_delta:=byte_delta-reader_journal_row_bytes(TG_TABLE_NAME,to_jsonb(OLD));END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  IF reader_journal_row_bytes(TG_TABLE_NAME,to_jsonb(NEW))>131072 THEN
   RAISE EXCEPTION 'Reader metadata exceeds the recoverable row budget' USING ERRCODE='P0001',CONSTRAINT='reader_journal_row_limit';
  END IF;
  row_delta:=row_delta+1;byte_delta:=byte_delta+reader_journal_row_bytes(TG_TABLE_NAME,to_jsonb(NEW));
 END IF;
 SELECT rows,bytes INTO current_rows,current_bytes FROM reader_journal_budget WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reader metadata budget is missing' USING ERRCODE='P0001',CONSTRAINT='reader_journal_budget_integrity';END IF;
 UPDATE reader_journal_budget SET rows=current_rows+row_delta,bytes=current_bytes+byte_delta WHERE singleton;
 RETURN NULL;
END $$;

-- A sorted fixed-size row hash spills through PostgreSQL's bounded work_mem.
-- Folding one digest at a time avoids string_agg of an ever-growing audit log.
-- No SECURITY DEFINER: callers keep their normal table permissions.
CREATE FUNCTION gargantua_table_fingerprint_v2(target regclass) RETURNS json
 LANGUAGE plpgsql STABLE SECURITY INVOKER
 SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO, YMD' AS $$
DECLARE state bytea:=sha256(convert_to('gargantua-table-fingerprint-v2','UTF8'));
 row_hash bytea;total bigint:=0;
BEGIN
 FOR row_hash IN EXECUTE format('SELECT sha256(convert_to(to_jsonb(t)::text,''UTF8'')) FROM %s t ORDER BY 1',target) LOOP
  state:=sha256(state||row_hash);total:=total+1;
 END LOOP;
 RETURN json_build_object('algorithm','sha256-sorted-fold-v2','count',total,'fingerprint',encode(state,'hex'));
END $$;
-- Check the committed result, after accepted receipts and change-feed pruning.
-- Transient rows inside a bounded batch must not prevent the pruning itself.
CREATE FUNCTION reader_journal_enforce() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM reader_journal_budget WHERE singleton AND (rows>250000 OR bytes>100663296)) THEN
  RAISE EXCEPTION 'Reader metadata has reached its recoverable storage budget' USING ERRCODE='P0001',CONSTRAINT='reader_journal_capacity';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reader_journal_capacity_check AFTER INSERT OR UPDATE ON reader_journal_budget
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reader_journal_enforce();
UPDATE reader_journal_budget SET rows=rows WHERE singleton;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['reader_profiles','reader_devices','reader_entities','reader_mutations','reader_changes'] LOOP
  EXECUTE format('CREATE TRIGGER reader_journal_row_account AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reader_journal_account()',table_name);
  EXECUTE format('CREATE TRIGGER reader_journal_truncate_account AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reader_journal_account()',table_name);
 END LOOP;
END $$;
