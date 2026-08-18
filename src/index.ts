import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import {
  createOAuthState,
  deleteOAuthState,
  deleteUser,
  getOAuthState,
  getUser,
  upsertUserToken,
} from "./db";
import { decrypt, encrypt } from "./crypto";
import { buildAuthUrl, exchangeCodeForTokens, getAccessToken } from "./oauth";
import { uploadToDrive } from "./drive";

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  BOT_WEBHOOK_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BASE_URL: string;
  ENCRYPTION_KEY: string;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024; // سقف Bot API معمولی تلگرام

function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  bot.command("start", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(env.DB, telegramId);
    if (user) {
      await ctx.reply("✅ شما از قبل به گوگل‌درایو متصل هستید. کافیه یه فایل بفرستید.");
      return;
    }

    const state = crypto.randomUUID();
    await createOAuthState(env.DB, state, telegramId);
    const url = buildAuthUrl(env, state);
    const keyboard = new InlineKeyboard().url("🔗 اتصال به گوگل‌درایو", url);

    await ctx.reply(
      "سلام! برای شروع، اول باید حساب گوگل‌درایوت رو وصل کنی:",
      { reply_markup: keyboard }
    );
  });

  bot.command("disconnect", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    await deleteUser(env.DB, telegramId);
    await ctx.reply("اتصال شما به گوگل‌درایو قطع شد. برای اتصال دوباره /start رو بزنید.");
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "دستورها:\n/start — اتصال به گوگل‌درایو\n/disconnect — قطع اتصال\n\n" +
        "بعد از اتصال، کافیه هر فایلی (سند، عکس، ویدیو یا صدا) بفرستید تا در درایو شما آپلود بشه.\n" +
        `⚠️ سقف حجم فایل: ${MAX_FILE_BYTES / 1024 / 1024} مگابایت (محدودیت Bot API تلگرام).`
    );
  });

  bot.on(["message:document", "message:photo", "message:video", "message:audio"], async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !ctx.chat) return;

    const user = await getUser(env.DB, telegramId);
    if (!user) {
      await ctx.reply("قبلش باید با /start حساب گوگل‌درایوت رو وصل کنی.");
      return;
    }

    let fileId: string;
    let fileName: string;
    let mimeType = "application/octet-stream";

    const msg = ctx.message;
    if (msg?.document) {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name ?? `file_${Date.now()}`;
      mimeType = msg.document.mime_type ?? mimeType;
    } else if (msg?.video) {
      fileId = msg.video.file_id;
      fileName = msg.video.file_name ?? `video_${Date.now()}.mp4`;
      mimeType = msg.video.mime_type ?? "video/mp4";
    } else if (msg?.audio) {
      fileId = msg.audio.file_id;
      fileName = msg.audio.file_name ?? `audio_${Date.now()}.mp3`;
      mimeType = msg.audio.mime_type ?? "audio/mpeg";
    } else if (msg?.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      fileId = largest.file_id;
      fileName = `photo_${Date.now()}.jpg`;
      mimeType = "image/jpeg";
    } else {
      return;
    }

    const statusMsg = await ctx.reply("⏳ در حال آپلود به گوگل‌درایو...");

    try {
      const file = await ctx.api.getFile(fileId);

      if (file.file_size && file.file_size > MAX_FILE_BYTES) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ حجم فایل بیشتر از ${MAX_FILE_BYTES / 1024 / 1024} مگابایته و تلگرام اجازه‌ی دانلودش رو به ربات نمی‌ده.`
        );
        return;
      }

      if (!file.file_path) throw new Error("file_path missing from Telegram response");

      const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) throw new Error(`telegram file download failed: ${fileRes.status}`);
      const fileBytes = await fileRes.arrayBuffer();

      const refreshToken = await decrypt(env.ENCRYPTION_KEY, user.encrypted_refresh_token, user.iv);
      const accessToken = await getAccessToken(env, refreshToken);

      const driveFile = await uploadToDrive(accessToken, fileName, mimeType, fileBytes);

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `✅ آپلود شد!\n📄 ${fileName}\n🔗 ${driveFile.webViewLink}`
      );
    } catch (err) {
      console.error("upload error:", err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "❌ آپلود ناموفق بود. لطفاً دوباره امتحان کنید یا با /start اتصال رو تازه کنید."
      );
    }
  });

  return bot;
}

async function handleOAuthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse("اتصال لغو شد", "می‌تونید به تلگرام برگردید و دوباره از /start تلاش کنید.");
  }

  if (!code || !state) {
    return new Response("Missing code/state", { status: 400 });
  }

  const oauthState = await getOAuthState(env.DB, state);
  if (!oauthState) {
    return htmlResponse("لینک منقضی شده", "لطفاً از تلگرام دوباره روی دکمه‌ی اتصال بزنید.");
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(env, code);
  } catch (err) {
    console.error("token exchange error:", err);
    return htmlResponse("خطا در اتصال", "لطفاً دوباره تلاش کنید.");
  }

  if (!tokens.refresh_token) {
    return htmlResponse(
      "خطا در دریافت مجوز",
      "توکن دریافت نشد. اگر قبلاً یک‌بار به این اپلیکیشن دسترسی داده‌اید، از تنظیمات حساب گوگل (Google Account → Security → Third-party access) دسترسی قبلی رو لغو کنید و دوباره از تلگرام تلاش کنید."
    );
  }

  const { ciphertext, iv } = await encrypt(env.ENCRYPTION_KEY, tokens.refresh_token);
  await upsertUserToken(env.DB, oauthState.telegram_id, ciphertext, iv);
  await deleteOAuthState(env.DB, state);

  // اطلاع به کاربر در تلگرام
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: oauthState.telegram_id,
      text: "✅ اتصال به گوگل‌درایو با موفقیت انجام شد! حالا هر فایلی بفرستید، آپلود می‌شه.",
    }),
  });

  return htmlResponse("متصل شد ✅", "می‌تونید این صفحه رو ببندید و به تلگرام برگردید.");
}

function htmlResponse(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 60px 20px;
           background: #0f172a; color: #e2e8f0; }
    h1 { color: #22c55e; }
    p { color: #94a3b8; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/oauth/callback") {
      return handleOAuthCallback(req, env);
    }

    if (url.pathname === "/webhook") {
      const bot = createBot(env);
      const handleUpdate = webhookCallback(bot, "cloudflare-mod", {
        secretToken: env.BOT_WEBHOOK_SECRET,
      });
      return handleUpdate(req);
    }

    if (url.pathname === "/") {
      return new Response("Telegram → Google Drive bot is running.");
    }

    return new Response("Not found", { status: 404 });
  },
};
