-- Load test data, used only by npm run load. Never part of the seed.
--
-- The seed has one vehicle per customer, which isn't enough for a burst where
-- every request needs a different car. This adds one load customer with 500
-- vehicles. Ids, VINs and names are fixed and made up, and every insert is
-- ON CONFLICT DO NOTHING, so running it twice adds nothing.
--
-- It needs the seed to have run first (docker compose up does that), since
-- it only adds a customer and vehicles and books nothing.
--
-- Customer id: 10ad0000-0000-4000-8000-000000000001
-- Vehicle ids: 10ad0e00-0000-4000-8000-000000000001 to ...000000000500

BEGIN;

INSERT INTO customers (id, name, email)
VALUES ('10ad0000-0000-4000-8000-000000000001', 'Load Test Customer', 'load-test@example.com')
ON CONFLICT DO NOTHING;

INSERT INTO vehicles (id, customer_id, vin, make, model, year)
SELECT ('10ad0e00-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10ad0000-0000-4000-8000-000000000001',
       -- 17 characters like a real VIN, but clearly fake
       'LOADCAR' || lpad(n::text, 10, '0'),
       'Loadmake',
       'Loadmodel',
       2020
FROM generate_series(1, 500) AS n
ON CONFLICT DO NOTHING;

COMMIT;
