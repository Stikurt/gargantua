CREATE TABLE IF NOT EXISTS profiles (
    id uuid PRIMARY KEY, login text UNIQUE NOT NULL, password text NOT NULL,
    role text NOT NULL DEFAULT 'reader' CHECK(role IN ('owner','reader','trusted-import')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY, profile_id uuid NOT NULL REFERENCES profiles(id),
    csrf text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS settings (id int PRIMARY KEY CHECK(id=1), imports_paused boolean NOT NULL DEFAULT false, serving_paused boolean NOT NULL DEFAULT false);
  INSERT INTO settings(id) VALUES(1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS imports (
    id uuid PRIMARY KEY, requested_by uuid NOT NULL REFERENCES profiles(id), kind text NOT NULL,
    filename text NOT NULL DEFAULT '', source_url text, status text NOT NULL, stage text NOT NULL DEFAULT '',
    security_state text NOT NULL DEFAULT 'pending', report jsonb NOT NULL DEFAULT '{}',
    error text, book_id uuid, approved_by uuid REFERENCES profiles(id), decision_reason text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS books (
    id uuid PRIMARY KEY, title text NOT NULL, author text NOT NULL DEFAULT '', language text NOT NULL DEFAULT '',
    chapter_count int NOT NULL, sha256 text NOT NULL, import_id uuid NOT NULL REFERENCES imports(id),
    requested_by uuid NOT NULL REFERENCES profiles(id), security_state text NOT NULL DEFAULT 'passed',
    blocked_reason text, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS reading (
    profile_id uuid REFERENCES profiles(id), book_id uuid REFERENCES books(id),
    chapter int NOT NULL DEFAULT 0, position double precision NOT NULL DEFAULT 0,
    shelf text NOT NULL DEFAULT 'reading', updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(profile_id, book_id)
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES profiles(id), book_id uuid NOT NULL REFERENCES books(id),
    chapter int NOT NULL, position double precision NOT NULL DEFAULT 0, note text NOT NULL DEFAULT '', created_at timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS audit (
    id bigserial PRIMARY KEY, actor uuid REFERENCES profiles(id), action text NOT NULL,
    target text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS system_status (name text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());
  CREATE TABLE IF NOT EXISTS profile_catalogs (
    profile_id uuid PRIMARY KEY REFERENCES profiles(id), revision int NOT NULL DEFAULT 0,
    catalogs jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS imports_status ON imports(status, created_at);
  ALTER TABLE imports ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}';
  CREATE INDEX IF NOT EXISTS audit_target ON audit(target);
