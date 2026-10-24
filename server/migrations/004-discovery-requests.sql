CREATE TABLE discovery_requests(
 id uuid PRIMARY KEY,requested_by uuid NOT NULL REFERENCES profiles(id),
 body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND octet_length(input::text)<=8192),
 query_text text NOT NULL CHECK(char_length(query_text) BETWEEN 2 AND 300),
 status text NOT NULL CHECK(status IN('pending-approval','queued','processing','needs-review','selected','acquiring','book-ready','cancelled','error')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),approved_by uuid REFERENCES profiles(id),decision_reason text,
 plan jsonb CHECK(plan IS NULL OR (jsonb_typeof(plan)='object' AND octet_length(plan::text)<=262144)),
 plan_revision integer NOT NULL DEFAULT 0 CHECK(plan_revision>=0),selected_candidate_id text CHECK(char_length(selected_candidate_id) BETWEEN 1 AND 120),
 outputs jsonb NOT NULL CHECK(jsonb_typeof(outputs)='object' AND octet_length(outputs::text)<=8192),
 import_id uuid UNIQUE REFERENCES imports(id),phase text CHECK(phase IN('discovery','acquisition')),
 attempt_number integer NOT NULL DEFAULT 0 CHECK(attempt_number>=0),attempt_token uuid,lease_expires_at timestamptz,
 error text CHECK(char_length(error)<=600),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,requested_by),CHECK(status<>'processing' OR (attempt_token IS NOT NULL AND lease_expires_at IS NOT NULL AND phase IS NOT NULL)),
 CHECK((plan IS NULL AND plan_revision=0 AND selected_candidate_id IS NULL) OR (plan IS NOT NULL AND plan_revision>0))
);
CREATE TABLE discovery_idempotency(
 profile_id uuid NOT NULL REFERENCES profiles(id),key uuid NOT NULL,body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(profile_id,key),
 FOREIGN KEY(request_id,profile_id) REFERENCES discovery_requests(id,requested_by)
);
CREATE TABLE discovery_attempts(
 token uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES discovery_requests(id),number integer NOT NULL CHECK(number>0),
 phase text NOT NULL CHECK(phase IN('discovery','acquisition')),state text NOT NULL CHECK(state IN('running','finished','failed','interrupted')),
 error text CHECK(char_length(error)<=600),started_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,
 UNIQUE(request_id,number),UNIQUE(token,request_id)
);
ALTER TABLE discovery_requests ADD CONSTRAINT discovery_attempt_owner FOREIGN KEY(attempt_token,id) REFERENCES discovery_attempts(token,request_id);
CREATE INDEX discovery_requests_queue ON discovery_requests(status,created_at);
CREATE INDEX discovery_requests_owner ON discovery_requests(requested_by,created_at DESC);
CREATE INDEX discovery_requests_active_hash ON discovery_requests(requested_by,body_hash) WHERE status IN('pending-approval','queued','processing','needs-review','selected','acquiring');
CREATE INDEX discovery_attempts_request ON discovery_attempts(request_id,number);
