-- Assign farmId from the creator's current farm
 UPDATE wiki_entries
 SET farm_id = profiles.farm_id
 FROM profiles
 WHERE wiki_entries.created_by = profiles.id
   AND wiki_entries.farm_id IS NULL
   AND profiles.farm_id IS NOT NULL;

 -- Delete entries with no resolvable farm (creator has no farm)
 DELETE FROM wiki_entries
 WHERE farm_id IS NULL;