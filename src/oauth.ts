import type { Env } from "./index";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

// اسکوپ محدود: ربات فقط به فایل‌هایی دسترسی داره که خودش با همین اپ آپلود کرده،
// نه به کل درایو کاربر. این هم امن‌تره و هم تایید گوگل (verification) ساده‌تری داره.
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export function buildAuthUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.BASE_URL}/oauth/callback`,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // تضمین می‌کنه هر بار refresh_token برگرده
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

export async function exchangeCodeForTokens(env: Env, code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.BASE_URL}/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export async function getAccessToken(env: Env, refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json<TokenResponse>();
  return data.access_token;
}

/** لغو واقعی دسترسیِ اپ در سمت گوگل (نه فقط پاک‌کردن از دیتابیس خودمون). */
export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  // اگه توکن از قبل نامعتبر/لغوشده بوده، گوگل هم همچنان 200 برمی‌گردونه؛ فقط خطاهای واقعی رو throw کن.
  if (!res.ok) {
    throw new Error(`revoke failed (${res.status}): ${await res.text()}`);
  }
}
