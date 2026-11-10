#!/bin/bash
# My own check of the agent's main claim before I based ADR 001 on it.
# Plain INSERT vs INSERT ... ON CONFLICT DO NOTHING, 16 clients all inserting
# the same bay and time for 10 seconds. Run with Docker available.
set -e
cat > /tmp/s.sql <<'SQL'
create extension btree_gist;
create table appt (id bigserial primary key, bay int not null, tech int not null, starts_at timestamptz not null, ends_at timestamptz not null,
  exclude using gist (bay with =, tstzrange(starts_at, ends_at, '[)') with &&));
SQL
cat > /tmp/p.sql <<'SQL'
insert into appt (bay, tech, starts_at, ends_at) values (1, 1, '2030-01-01 09:00Z', '2030-01-01 10:00Z');
delete from appt;
SQL
cat > /tmp/o.sql <<'SQL'
insert into appt (bay, tech, starts_at, ends_at) values (1, 1, '2030-01-01 09:00Z', '2030-01-01 10:00Z') on conflict do nothing;
delete from appt;
SQL
docker rm -f verify-e2 >/dev/null 2>&1 || true
docker run -d --name verify-e2 -e POSTGRES_PASSWORD=x postgres:16-alpine >/dev/null
sleep 6
for f in s p o; do docker cp /tmp/$f.sql verify-e2:/$f.sql; done
docker exec verify-e2 psql -qU postgres -f /s.sql
echo "== plain INSERT, 16 clients, 10s"
docker exec verify-e2 pgbench -U postgres -n -c 16 -T 10 -f /p.sql postgres 2>&1 | grep -E 'transactions actually|failed|latency average'
echo "== ON CONFLICT DO NOTHING, 16 clients, 10s"
docker exec verify-e2 pgbench -U postgres -n -c 16 -T 10 -f /o.sql postgres 2>&1 | grep -E 'transactions actually|failed|latency average'
echo "deadlock lines in the server log: $(docker logs verify-e2 2>&1 | grep -c 'deadlock detected')"
docker rm -f verify-e2 >/dev/null
