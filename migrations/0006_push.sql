-- Reminder notifications while the app is closed. Opt-in per device and empty until someone
-- turns it on: the tables hold when a reminder is due and which note it belongs to, never a
-- title or text. Turning the switch off, signing out or trashing the note deletes the rows.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,           -- SHA-256 of the endpoint, hex
  user_id     TEXT NOT NULL,
  endpoint    TEXT NOT NULL,              -- the browser vendor's push address for one device
  p256dh      TEXT NOT NULL,              -- base64url, the device's public key (encrypts the push)
  auth        TEXT NOT NULL,              -- base64url, 16 bytes
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS reminders (
  subscription_id  TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  note_id          TEXT NOT NULL,
  due_at           INTEGER NOT NULL,      -- epoch ms
  PRIMARY KEY (subscription_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_note ON reminders (user_id, note_id);
