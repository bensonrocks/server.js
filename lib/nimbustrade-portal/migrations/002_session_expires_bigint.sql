-- Session expiry is a JavaScript millisecond timestamp (Date.now() + ttl).
-- Postgres INTEGER is int4 and rejects that value; BIGINT holds it.
-- Fresh databases already create these columns as BIGINT in 001_init.sql.
-- This alters databases that applied 001 while the columns were still INTEGER.

ALTER TABLE nt_sessions ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE nt_vendor_sessions ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE nt_staff_sessions ALTER COLUMN expires_at TYPE BIGINT;
