CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  encrypted_refresh_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  drive_folder_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- اگه قبلاً این جدول رو ساخته بودید، این خط رو جدا اجرا کنید:
-- ALTER TABLE users ADD COLUMN drive_folder_id TEXT;

CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
