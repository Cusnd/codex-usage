-- Keep the request's generated device ID immutable; a resume can target an existing device.
-- Separate storage avoids collisions with still-live authorization receipts for that device.
ALTER TABLE device_authorizations ADD COLUMN resumed_device_id TEXT;
