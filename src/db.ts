export interface UserRow {
  telegram_id: number;
  encrypted_refresh_token: string;
  iv: string;
  drive_folder_id: string | null;
}

export interface OAuthStateRow {
  state: string;
  telegram_id: number;
  created_at: string;
}

export async function getUser(db: D1Database, telegramId: number): Promise<UserRow | null> {
  const row = await db
    .prepare("SELECT telegram_id, encrypted_refresh_token, iv, drive_folder_id FROM users WHERE telegram_id = ?")
    .bind(telegramId)
    .first<UserRow>();
  return row ?? null;
}

export async function setUserFolder(db: D1Database, telegramId: number, folderId: string): Promise<void> {
  await db
    .prepare("UPDATE users SET drive_folder_id = ?, updated_at = datetime('now') WHERE telegram_id = ?")
    .bind(folderId, telegramId)
    .run();
}

export async function upsertUserToken(
  db: D1Database,
  telegramId: number,
  encryptedRefreshToken: string,
  iv: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (telegram_id, encrypted_refresh_token, iv, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET
         encrypted_refresh_token = excluded.encrypted_refresh_token,
         iv = excluded.iv,
         updated_at = datetime('now')`
    )
    .bind(telegramId, encryptedRefreshToken, iv)
    .run();
}

export async function deleteUser(db: D1Database, telegramId: number): Promise<void> {
  await db.prepare("DELETE FROM users WHERE telegram_id = ?").bind(telegramId).run();
}

export async function createOAuthState(
  db: D1Database,
  state: string,
  telegramId: number
): Promise<void> {
  await db
    .prepare("INSERT INTO oauth_state (state, telegram_id) VALUES (?, ?)")
    .bind(state, telegramId)
    .run();
}

export async function getOAuthState(db: D1Database, state: string): Promise<OAuthStateRow | null> {
  const row = await db
    .prepare("SELECT state, telegram_id, created_at FROM oauth_state WHERE state = ?")
    .bind(state)
    .first<OAuthStateRow>();
  return row ?? null;
}

export async function deleteOAuthState(db: D1Database, state: string): Promise<void> {
  await db.prepare("DELETE FROM oauth_state WHERE state = ?").bind(state).run();
}
