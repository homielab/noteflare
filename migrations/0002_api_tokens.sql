-- Personal access tokens for the public API (/api/v1).
-- Only a SHA-256 hash of each token is stored; the secret is shown once when created.
-- A token never gives access to note content: notes stay encrypted, and clients
-- still need the user's passphrase to decrypt them.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,                     -- UUID
  user_id       TEXT NOT NULL,                        -- email from Cloudflare Access
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,                        -- first characters, for display
  hash          TEXT NOT NULL UNIQUE,                 -- hex SHA-256 of the full token
  scope         TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  expires_at    INTEGER                               -- NULL = never expires
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id);
