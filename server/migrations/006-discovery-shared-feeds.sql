-- Full branch acquisition is shared; each discovery keeps its own initiator.
ALTER TABLE discovery_requests DROP CONSTRAINT discovery_requests_import_id_key;
CREATE INDEX discovery_requests_import ON discovery_requests(import_id) WHERE import_id IS NOT NULL;
CREATE INDEX ranobe_run_chapters_checkpoint ON ranobe_run_chapters(chapter_id) WHERE chapter_id IS NOT NULL;
ALTER TABLE ranobe_feed_requests ADD COLUMN result_run_id uuid;
ALTER TABLE ranobe_feed_requests ADD CONSTRAINT ranobe_request_result_same_feed FOREIGN KEY(result_run_id,feed_id) REFERENCES ranobe_runs(id,feed_id);
UPDATE ranobe_feed_requests q SET result_run_id=r.id FROM ranobe_runs r,imports i
 WHERE q.import_id=r.import_id AND i.id=q.import_id AND i.status='completed' AND r.feed_id=q.feed_id AND r.status='ready';
CREATE FUNCTION protect_ranobe_request_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.result_run_id IS NOT NULL AND (NEW.result_run_id,NEW.feed_id,NEW.import_id,NEW.profile_id) IS DISTINCT FROM (OLD.result_run_id,OLD.feed_id,OLD.import_id,OLD.profile_id)
 THEN RAISE EXCEPTION 'Completed source request result and provenance are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ranobe_request_result_immutable BEFORE UPDATE ON ranobe_feed_requests FOR EACH ROW EXECUTE FUNCTION protect_ranobe_request_result();
-- A bounded 20k-chapter snapshot may have up to 20k single-chapter parts. Keep
-- ordinary outputs small, but allow the ordered UUID list for a ready feed.
ALTER TABLE discovery_requests DROP CONSTRAINT discovery_requests_outputs_check;
ALTER TABLE discovery_requests ADD CONSTRAINT discovery_requests_outputs_check CHECK(
 jsonb_typeof(outputs)='object' AND
 (octet_length(outputs::text)<=8192 OR
  COALESCE((octet_length(outputs::text)<=1048576 AND outputs->'book'->>'status'='ready' AND outputs->'book'->'multipart'='true'::jsonb AND jsonb_typeof(outputs->'book'->'publicationIds')='array' AND jsonb_array_length(outputs->'book'->'publicationIds') BETWEEN 1 AND 20000),false))
);
