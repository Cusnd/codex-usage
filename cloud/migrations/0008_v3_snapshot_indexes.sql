-- Fixed-cut recent reads include all events of an active thread. The lookup must
-- start from that thread instead of re-scanning every recent event for each page.
CREATE INDEX v3_entity_thread_time ON v3_entity_versions(user_id,epoch,kind,thread_id,at,valid_from,valid_to);
