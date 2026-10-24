#!/bin/sh
set -eu
case "${COTOLOGY_ADMIN_PASSWORD:-}${COTOLOGY_APP_PASSWORD:-}" in
  ''|*[!0-9a-f]*) echo 'Invalid maintenance credential' >&2; exit 1 ;;
esac
test "${#COTOLOGY_ADMIN_PASSWORD}" -eq 64
test "${#COTOLOGY_APP_PASSWORD}" -eq 64
if psql -U cotology_admin -d library -c 'SELECT 1' >/dev/null 2>&1; then maintenance_user=cotology_admin; else maintenance_user=library; fi
psql -v ON_ERROR_STOP=1 --username "$maintenance_user" --dbname library <<SQL
SELECT format('CREATE ROLE cotology_admin LOGIN SUPERUSER PASSWORD %L', '$COTOLOGY_ADMIN_PASSWORD') WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cotology_admin') \gexec
SELECT format('CREATE ROLE cotology_app LOGIN PASSWORD %L', '$COTOLOGY_APP_PASSWORD') WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cotology_app') \gexec
ALTER ROLE cotology_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$COTOLOGY_APP_PASSWORD';
ALTER DATABASE library OWNER TO cotology_app;
ALTER SCHEMA public OWNER TO cotology_app;
SELECT format('ALTER TABLE %I.%I OWNER TO cotology_app', n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO cotology_app', n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' \gexec
SELECT format('ALTER ROLE library PASSWORD %L', '$COTOLOGY_ADMIN_PASSWORD') WHERE EXISTS(SELECT 1 FROM pg_roles WHERE rolname='library') \gexec
SQL
