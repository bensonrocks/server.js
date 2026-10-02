-- Sets the stored hash for the existing bwlonline login on demo-client.
-- Does not insert a second user. The plaintext is not stored in this file.

UPDATE nt_users
SET password_hash = '5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5'
WHERE id = 'bwl-ops-demo'
  AND username = 'bwlonline'
  AND client_id = 'demo-client';

-- Removes one empty client created by mistake. Skipped if any dependent row exists.
DELETE FROM nt_clients
WHERE id = 'client_086ea0376b69b4a3'
  AND name = 'BWL Online'
  AND NOT EXISTS (SELECT 1 FROM nt_users WHERE client_id = 'client_086ea0376b69b4a3')
  AND NOT EXISTS (SELECT 1 FROM nt_orders WHERE client_id = 'client_086ea0376b69b4a3')
  AND NOT EXISTS (SELECT 1 FROM nt_locations WHERE client_id = 'client_086ea0376b69b4a3')
  AND NOT EXISTS (SELECT 1 FROM nt_inbound_shipments WHERE client_id = 'client_086ea0376b69b4a3')
  AND NOT EXISTS (SELECT 1 FROM nt_rate_cards WHERE client_id = 'client_086ea0376b69b4a3');
