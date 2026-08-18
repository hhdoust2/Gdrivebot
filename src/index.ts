import { Bot, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import {
  createOAuthState,
  deleteOAuthState,
  deleteUser,
  getOAuthState,
  getUser,
  setUserFolder,
  upsertUserToken,
  UserRow,
} from "./db";
import { decrypt, encrypt } from "./crypto";
import { buildAuthUrl, exchangeCodeForTokens, getAccessToken, revokeToken } from "./oauth";
import {
  deleteFile,
  downloadFileBytes,
  getFileMeta,
  getOrCreateFolder,
  listFilesInFolder,
  uploadToDrive,
} from "./drive";

// سقفی که برای «ارسال» فایل توسط ربات به کاربر در تلگرام امن حساب می‌شه.
const MAX_SEND_BYTES = 50 * 1024 * 1024;

function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📤 آپلود فایل", "upload_hint")
    .row()
    .text("📋 لیست فایل‌ها", "list:0");
}

function fileNameLabel(name: string): string {
  return name.length > 28 ? name.slice(0, 27) + "…" : name;
}

function formatSize(size?: string): string {
  if (!size) return ""; 
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** توکن دسترسیِ درایو + آیدی پوشه رو برای یک کاربر آماده می‌کنه (برای استفاده در callback handlerها). */
async function prepareDriveAccess(
  env: Env,
  telegramId: number,
  user: UserRow
): Promise<{ accessToken: string; folderId: string }> {
  const refreshToken = await decrypt(env.ENCRYPTION_KEY, user.encrypted_refresh_token, user.iv);
  const accessToken = await getAccessToken(env, refreshToken);
  const folderId = await ensureFolder(env, telegramId, user, accessToken);
  return { accessToken, folderId };
}

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  BOT_WEBHOOK_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BASE_URL: string;
  ENCRYPTION_KEY: string;
  // اختیاری: فقط اگر سرویس Railway برای فایل‌های بزرگ راه‌اندازی شده باشه لازمه
  RAILWAY_LARGE_FILE_URL?: string;
  RAILWAY_SHARED_SECRET?: string;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024; // سقف Bot API معمولی تلگرام

/** آیدی پوشه‌ی اختصاصی ربات رو برمی‌گردونه؛ اگه در دیتابیس کش نشده بود، پیدا/می‌سازه و کش می‌کنه. */
async function ensureFolder(
  env: Env,
  telegramId: number,
  user: { drive_folder_id: string | null },
  accessToken: string
): Promise<string> {
  if (user.drive_folder_id) return user.drive_folder_id;
  const folderId = await getOrCreateFolder(accessToken);
  await setUserFolder(env.DB, telegramId, folderId);
  return folderId;
}

function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  bot.command("start", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await getUser(env.DB, telegramId);
    if (user) {
      await ctx.reply("✅ شما از قبل به گوگل‌درایو متصل هستید. از منوی زیر استفاده کنید:", {
        reply_markup: mainMenuKeyboard(),
      });
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

    const user = await getUser(env.DB, telegramId);
    if (!user) {
      await ctx.reply("شما در حال حاضر متصل نیستید.");
      return;
    }

    try {
      const refreshToken = await decrypt(env.ENCRYPTION_KEY, user.encrypted_refresh_token, user.iv);
      await revokeToken(refreshToken);
    } catch (err) {
      console.error("revoke error:", err);
      // حتی اگه revoke سمت گوگل fail بشه، توکن رو از دیتابیس خودمون پاک می‌کنیم تا ربات دیگه ازش استفاده نکنه.
    }

    await deleteUser(env.DB, telegramId);
    await ctx.reply(
      "✅ اتصال شما به گوگل‌درایو کاملاً قطع و دسترسی اپ لغو شد. برای اتصال دوباره /start رو بزنید."
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "دستورها:\n/start — اتصال به گوگل‌درایو\n/disconnect — قطع اتصال\n\n" +
        "بعد از اتصال، کافیه هر فایلی (سند، عکس، ویدیو یا صدا) بفرستید تا در درایو شما آپلود بشه.\n" +
        `📎 فایل تا ${MAX_FILE_BYTES / 1024 / 1024} مگابایت: مستقیم و سریع.\n` +
        "📦 فایل بزرگ‌تر: در پس‌زمینه با کمی تأخیر بیشتر آپلود می‌شه (اگه سرویس فایل‌های بزرگ فعال باشه)."
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
    let fileSize: number | undefined;

    const msg = ctx.message;
    if (msg?.document) {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name ?? `file_${Date.now()}`;
      mimeType = msg.document.mime_type ?? mimeType;
      fileSize = msg.document.file_size;
    } else if (msg?.video) {
      fileId = msg.video.file_id;
      fileName = msg.video.file_name ?? `video_${Date.now()}.mp4`;
      mimeType = msg.video.mime_type ?? "video/mp4";
      fileSize = msg.video.file_size;
    } else if (msg?.audio) {
      fileId = msg.audio.file_id;
      fileName = msg.audio.file_name ?? `audio_${Date.now()}.mp3`;
      mimeType = msg.audio.mime_type ?? "audio/mpeg";
      fileSize = msg.audio.file_size;
    } else if (msg?.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      fileId = largest.file_id;
      fileName = `photo_${Date.now()}.jpg`;
      mimeType = "image/jpeg";
      fileSize = largest.file_size;
    } else {
      return;
    }

    const statusMsg = await ctx.reply("⏳ در حال آپلود به گوگل‌درایو...");

    // فایل‌های بزرگ‌تر از سقف Bot API معمولی: مسیرشون رو به سرویس Railway (اگر تنظیم شده) می‌دیم.
    // نکته: برای این فایل‌ها اصلاً نباید ctx.api.getFile معمولی صدا زده بشه، چون خودِ تلگرام
    // برای فایل‌های بالای ۲۰ مگابایت روی Bot API عمومی این تماس رو با خطا رد می‌کنه.
    if (fileSize && fileSize > MAX_FILE_BYTES) {
      if (!env.RAILWAY_LARGE_FILE_URL || !env.RAILWAY_SHARED_SECRET) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ حجم فایل بیشتر از ${MAX_FILE_BYTES / 1024 / 1024} مگابایته و سرویس فایل‌های بزرگ هنوز تنظیم نشده.`
        );
        return;
      }

      try {
        const refreshToken = await decrypt(env.ENCRYPTION_KEY, user.encrypted_refresh_token, user.iv);
        const accessToken = await getAccessToken(env, refreshToken);
        const folderId = await ensureFolder(env, telegramId, user, accessToken);

        const res = await fetch(`${env.RAILWAY_LARGE_FILE_URL}/upload-large`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.RAILWAY_SHARED_SECRET}`,
          },
          body: JSON.stringify({
            fileId,
            botToken: env.BOT_TOKEN,
            driveAccessToken: accessToken,
            fileName,
            mimeType,
            chatId: ctx.chat.id,
            statusMessageId: statusMsg.message_id,
            folderId,
          }),
        });

        if (!res.ok) throw new Error(`railway service responded ${res.status}: ${await res.text()}`);

        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          "📤 فایل بزرگه — در پس‌زمینه آپلود می‌شه، وقتی تموم شد پیام می‌دم."
        );
      } catch (err) {
        console.error("large file handoff error:", err);
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          "❌ ارسال فایل به سرویس آپلود ناموفق بود. دوباره امتحان کنید."
        );
      }
      return;
    }

    try {
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) throw new Error("file_path missing from Telegram response");

      const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) throw new Error(`telegram file download failed: ${fileRes.status}`);
      const fileBytes = await fileRes.arrayBuffer();

      const refreshToken = await decrypt(env.ENCRYPTION_KEY, user.encrypted_refresh_token, user.iv);
      const accessToken = await getAccessToken(env, refreshToken);
      const folderId = await ensureFolder(env, telegramId, user, accessToken);

      const driveFile = await uploadToDrive(accessToken, fileName, mimeType, fileBytes, folderId);

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `✅ آپلود شد!\n📄 ${fileName}\n🔗 ${driveFile.webViewLink}`,
        { reply_markup: mainMenuKeyboard() }
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

  // ── منوی اصلی ──────────────────────────────────────────────
  bot.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("منوی اصلی:", { reply_markup: mainMenuKeyboard() });
  });

  bot.callbackQuery("upload_hint", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("📤 کافیه یه فایل (سند، عکس، ویدیو یا صدا) همین‌جا برام بفرستی.", {
      reply_markup: new InlineKeyboard().text("🔙 بازگشت", "menu"),
    });
  });

  // ── لیست فایل‌ها ────────────────────────────────────────────
  bot.callbackQuery(/^list:(.*)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const pageToken = ctx.match[1] || undefined;
    await ctx.answerCallbackQuery();

    const user = await getUser(env.DB, telegramId);
    if (!user) {
      await ctx.editMessageText("قبلش باید با /start حساب گوگل‌درایوت رو وصل کنی.");
      return;
    }

    try {
      const { accessToken, folderId } = await prepareDriveAccess(env, telegramId, user);
      const { files, nextPageToken } = await listFilesInFolder(accessToken, folderId, pageToken);

      if (files.length === 0 && !pageToken) {
        await ctx.editMessageText("📭 هنوز فایلی در پوشه‌ی درایوت نیست.", {
          reply_markup: new InlineKeyboard().text("🔙 بازگشت", "menu"),
        });
        return;
      }

      const kb = new InlineKeyboard();
      for (const f of files) {
        kb.text(`📄 ${fileNameLabel(f.name)}`, `file:${f.id}`).row();
      }
      if (nextPageToken) kb.text("➡️ صفحه‌ی بعد", `list:${nextPageToken}`).row();
      kb.text("🔙 بازگشت", "menu");

      await ctx.editMessageText("📋 فایل‌های تو در درایو:", { reply_markup: kb });
    } catch (err) {
      console.error("list error:", err);
      await ctx.editMessageText("❌ خطا در دریافت لیست فایل‌ها. دوباره امتحان کن.", {
        reply_markup: new InlineKeyboard().text("🔙 بازگشت", "menu"),
      });
    }
  });

  // ── جزئیات یک فایل ─────────────────────────────────────────
  bot.callbackQuery(/^file:(.+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const fileId = ctx.match[1];
    await ctx.answerCallbackQuery();

    const user = await getUser(env.DB, telegramId);
    if (!user) return;

    try {
      const { accessToken } = await prepareDriveAccess(env, telegramId, user);
      const meta = await getFileMeta(accessToken, fileId);

      const kb = new InlineKeyboard()
        .text("⬇️ دانلود", `dl:${fileId}`)
        .text("🗑 حذف", `del:${fileId}`)
        .row()
        .text("🔙 بازگشت به لیست", "list:0");

      await ctx.editMessageText(
        `📄 ${meta.name}\n${formatSize(meta.size) ? `حجم: ${formatSize(meta.size)}` : ""}`,
        { reply_markup: kb }
      );
    } catch (err) {
      console.error("file detail error:", err);
      await ctx.editMessageText("❌ خطا در دریافت اطلاعات فایل.", {
        reply_markup: new InlineKeyboard().text("🔙 بازگشت", "list:0"),
      });
    }
  });

  // ── دانلود فایل ────────────────────────────────────────────
  bot.callbackQuery(/^dl:(.+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const fileId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: "در حال آماده‌سازی دانلود..." });

    const user = await getUser(env.DB, telegramId);
    if (!user || !ctx.chat) return;

    try {
      const { accessToken } = await prepareDriveAccess(env, telegramId, user);
      const meta = await getFileMeta(accessToken, fileId);
      const sizeBytes = meta.size ? Number(meta.size) : 0;

      if (sizeBytes > MAX_SEND_BYTES) {
        await ctx.reply(
          `📦 این فایل بزرگ‌تر از ${MAX_SEND_BYTES / 1024 / 1024} مگابایته و نمی‌تونم مستقیم بفرستمش.\n🔗 لینک مشاهده/دانلود: ${meta.webViewLink}`
        );
        return;
      }

      const bytes = await downloadFileBytes(accessToken, fileId);
      await ctx.replyWithDocument(new InputFile(new Uint8Array(bytes), meta.name));
    } catch (err) {
      console.error("download error:", err);
      await ctx.reply("❌ دانلود ناموفق بود. دوباره امتحان کن.");
    }
  });

  // ── حذف فایل (با تأیید) ────────────────────────────────────
  bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard()
      .text("✅ بله، حذف کن", `delok:${fileId}`)
      .row()
      .text("🔙 انصراف", `file:${fileId}`);

    await ctx.editMessageText("❗️ مطمئنی می‌خوای این فایل رو برای همیشه حذف کنی؟", {
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^delok:(.+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const fileId = ctx.match[1];
    await ctx.answerCallbackQuery();

    const user = await getUser(env.DB, telegramId);
    if (!user) return;

    try {
      const { accessToken } = await prepareDriveAccess(env, telegramId, user);
      await deleteFile(accessToken, fileId);
      await ctx.editMessageText("🗑 فایل حذف شد.", {
        reply_markup: new InlineKeyboard().text("🔙 بازگشت به لیست", "list:0"),
      });
    } catch (err) {
      console.error("delete error:", err);
      await ctx.editMessageText("❌ حذف ناموفق بود. دوباره امتحان کن.", {
        reply_markup: new InlineKeyboard().text("🔙 بازگشت", `file:${fileId}`),
      });
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
      "توکن refresh دریافت نشد. اگر قبلاً این اپلیکیشن را مجاز کرده‌اید، لطفاً در تنظیمات حساب گوگل دسترسی قبلی را حذف کرده و دوباره تلاش کنید."
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
      text: "✅ اتصال به گوگل‌درایو با موفقیت انجام شد! از منوی زیر استفاده کنید یا مستقیم یه فایل بفرستید.",
      reply_markup: mainMenuKeyboard(),
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
