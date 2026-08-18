CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  encrypted_refresh_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
