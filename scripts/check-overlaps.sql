-- Lists every way the appointments table breaks the no double booking rule.
-- Zero rows means clean.
--
-- It checks the exclusion constraints from the outside, so it doesn't use
-- them or tstzrange at all. Two active (not cancelled) appointments clash when
-- a.starts_at < b.ends_at and b.starts_at < a.ends_at on the same bay, the
-- same technician or the same vehicle. That is the half open rule, so a job
-- ending at 10:00 and one starting at 10:00 don't show up. a.id < b.id lists
-- each pair once.
--
-- It also lists any appointment whose bay or technician belongs to a
-- different dealership (or doesn't exist at all), which is what the composite
-- foreign keys are there to stop. Those keys hold for cancelled rows too, so
-- this part doesn't skip them.
--
-- Run it with psql against the compose database:
--   docker compose exec -T db psql -U scheduler -d scheduler < scripts/check-overlaps.sql
-- npm run load runs it at the end too.

SELECT 'bay overlap' AS problem,
       a.id AS appointment_id, b.id AS other_appointment_id,
       a.service_bay_id AS resource_id,
       a.starts_at, a.ends_at, b.starts_at AS other_starts_at, b.ends_at AS other_ends_at
FROM appointments a
JOIN appointments b
  ON b.service_bay_id = a.service_bay_id
 AND a.id < b.id
 AND a.starts_at < b.ends_at
 AND b.starts_at < a.ends_at
WHERE a.status <> 'cancelled' AND b.status <> 'cancelled'

UNION ALL

SELECT 'technician overlap',
       a.id, b.id, a.technician_id,
       a.starts_at, a.ends_at, b.starts_at, b.ends_at
FROM appointments a
JOIN appointments b
  ON b.technician_id = a.technician_id
 AND a.id < b.id
 AND a.starts_at < b.ends_at
 AND b.starts_at < a.ends_at
WHERE a.status <> 'cancelled' AND b.status <> 'cancelled'

UNION ALL

SELECT 'vehicle overlap',
       a.id, b.id, a.vehicle_id,
       a.starts_at, a.ends_at, b.starts_at, b.ends_at
FROM appointments a
JOIN appointments b
  ON b.vehicle_id = a.vehicle_id
 AND a.id < b.id
 AND a.starts_at < b.ends_at
 AND b.starts_at < a.ends_at
WHERE a.status <> 'cancelled' AND b.status <> 'cancelled'

UNION ALL

-- A left join, so a bay that doesn't exist at all shows up too
SELECT 'bay from another dealership',
       a.id, NULL, a.service_bay_id,
       a.starts_at, a.ends_at, NULL, NULL
FROM appointments a
LEFT JOIN service_bays sb ON sb.id = a.service_bay_id
WHERE sb.id IS NULL OR sb.dealership_id <> a.dealership_id

UNION ALL

SELECT 'technician from another dealership',
       a.id, NULL, a.technician_id,
       a.starts_at, a.ends_at, NULL, NULL
FROM appointments a
LEFT JOIN technicians t ON t.id = a.technician_id
WHERE t.id IS NULL OR t.dealership_id <> a.dealership_id

ORDER BY problem, starts_at, appointment_id;
