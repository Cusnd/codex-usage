-- An applied receipt can release a stale immutable handoff without retiring the current legacy head.
ALTER TABLE v3_receipts ADD COLUMN handoff_results TEXT;
