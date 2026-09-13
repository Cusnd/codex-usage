-- Additive read optimization; candidate payloads and collector protocol are unchanged.
-- Device MIN/MAX queries read one active timestamp at each ordered boundary.
CREATE INDEX v3_candidates_device_coverage
  ON v3_candidates(user_id, uploader_device_id, at)
  WHERE active = 1;
