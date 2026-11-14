-- Each user's data key (DEK), wrapped by a passphrase-derived key and by
-- the recovery key. The server never sees the DEK in plaintext.
CREATE TABLE IF NOT EXISTS vaults (
  user_id       TEXT PRIMARY KEY,          -- email from Cloudflare Access
  kdf           TEXT NOT NULL,             -- JSON: algorithm + parameters + salt (base64)
  wrapped_dek   TEXT NOT NULL,             -- base64(iv || AES-GCM(KEK, DEK))
  recovery_dek  TEXT NOT NULL,             -- base64(iv || AES-GCM(KEK_recovery, DEK))
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- One row per note: all content (title, Markdown, labels, color) is in the ciphertext.
-- Only the flags needed for sorting/filtering are plaintext.
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT NOT NULL,               -- UUID generated on the client
  user_id     TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,               -- base64
  iv          TEXT NOT NULL,               -- base64, 12 byte
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  trashed_at  INTEGER,                     -- epoch ms, NULL = not in trash
  position    REAL NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_trashed ON notes (trashed_at) WHERE trashed_at IS NOT NULL;
