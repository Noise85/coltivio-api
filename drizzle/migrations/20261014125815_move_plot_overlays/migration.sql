-- Move untouched overlay plots (trees, Ackerschonstreifen) out of plots. Plots with any entries stay.
WITH movable AS (
  SELECT p.*
  FROM plots p
  WHERE p.usage IN (921, 922, 923, 924, 925, 926, 927, 928, 950, 951)
    AND NOT EXISTS (SELECT 1 FROM tillages t WHERE t.plot_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM crop_protection_applications c WHERE c.plot_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM fertilizer_applications f WHERE f.plot_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM harvests h WHERE h.plot_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM plot_journal_entries j WHERE j.plot_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM crop_rotation_draft_plan_plots d WHERE d.plot_id = p.id)
    AND (SELECT count(*) FROM crop_rotations r WHERE r.plot_id = p.id) <= 1
),
inserted AS (
  INSERT INTO plot_overlays (farm_id, name, local_id, usage, usage_name, size, geometry, external_id, source)
  SELECT farm_id, name, local_id, usage, NULL, size, geometry, md5(ST_AsBinary(geometry)) || ':' || usage, 'migration'
  FROM movable
  ON CONFLICT (farm_id, external_id) DO NOTHING
  RETURNING id
)
DELETE FROM plots WHERE id IN (SELECT id FROM movable);
