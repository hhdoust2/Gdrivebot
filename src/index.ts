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

/**
 * دکمه‌های کوتاه (مثل «🔙 بازگشت») رو با فاصله‌ی نامرئی (non-breaking space) پد می‌کنه
 * تا عرض بصری‌شون به دکمه‌های بلندتر نزدیک‌تر بشه. تلگرام هر دکمه رو دقیقاً به اندازه‌ی
 * طول متنش می‌سازه (نه عرض ثابت)، پس این تنها راه نزدیک‌کردن اندازه‌هاست.
 */
function pad(label: string, targetLen = 18): string {
  const len = [...label].length;
  if (len >= targetLen) return label;
  const totalPad = targetLen - len;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return "\u00A0".repeat(left) + label + "\u00A0".repeat(right);
}

function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(pad("📤 آپلود فایل"), "upload_hint")
    .row()
    .text(pad("📋 لیست فایل‌ها"), "list:0")
    .row()
    .text(pad("🔓 قطع اتصال"), "disconnect");
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

// Rate limiting ساده: هر user حداکثر ۱۰ تا بر ثانیه درخواست
const rateLimitMap = new Map<number, number[]>();

function isRateLimited(telegramId: number): boolean {
  const now = Date.now();
  const limit = 10; // درخواست‌های مجاز در پنجره‌ی زمانی
  const window = 1000; // یک ثانیه

  // جلوگیری از نشت حافظه: اگه map خیلی بزرگ شد (خیلی کاربر متفاوت)، پاکش کن.
  // چون Workerها short-lived هستن این به‌ندرت لازم می‌شه، ولی به‌عنوان محافظ خوبه.
  if (rateLimitMap.size > 5000) rateLimitMap.clear();

  let timestamps = rateLimitMap.get(telegramId) || [];
  timestamps = timestamps.filter((t) => now - t < window);

  if (timestamps.length >= limit) {
    console.warn(`Rate limit exceeded for user ${telegramId}`);
    return true;
  }

  timestamps.push(now);
  rateLimitMap.set(telegramId, timestamps);
  return false;
}

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

  // Safety net سراسری: اگه هر handler ای throw کنه، اینجا گرفته می‌شه
  // و دیگه exception به بیرون (به webhookCallback) نشت نمی‌کنه.
  // این جلوی چیزی رو می‌گیره که باعث می‌شد Telegram فکر کنه delivery
  // fail شده و همون update رو بارها retry کنه (که خودش می‌تونست
  // باعث فعال‌شدن فیلتر آنتی‌اسپم بشه).
  bot.catch((err) => {
    console.error("Unhandled bot error:", err.error, "| update:", JSON.stringify(err.ctx.update));
  });

  // Rate limiting middleware
  bot.use(async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (telegramId && isRateLimited(telegramId)) {
      console.warn(`Rate limited request from ${telegramId}`);
      // فقط خاموش می‌کنیم، جواب ندادن بهتره تا spam filter‌ها فکر نکنند مجوز داریم
      return;
    }
    await next();
  });

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
    const connectUrl = `${env.BASE_URL.replace(/\/+$/, "")}/connect?state=${state}`;
    const keyboard = new InlineKeyboard().url("🔗 اتصال به گوگل‌درایو", connectUrl);

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
      reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت"), "menu"),
    });
  });

  bot.callbackQuery("disconnect", async (ctx) => {
    const telegramId = ctx.from.id;
    await ctx.answerCallbackQuery();

    // مهم: حتی اگه decrypt یا revoke سمت گوگل fail بشه (مثلاً چون کلید رمزنگاری
    // بعداً عوض شده و توکن قدیمی دیگه قابل decrypt نیست)، باز هم باید کاربر از
    // دیتابیس خودمون حذف بشه — وگرنه کاربر برای همیشه «متصل» فرض می‌شه و
    // دیگه نمی‌تونه دوباره وصل بشه.
    try {
      const user = await getUser(env.DB, telegramId);
      if (user) {
        try {
          const refreshToken = await decrypt(env.ENCRYPTION_KEY, user.encrypted_refresh_token, user.iv);
          await revokeToken(refreshToken);
        } catch (revokeErr) {
          console.error("revoke/decrypt error (continuing to delete local record):", revokeErr);
        }
      }
    } finally {
      await deleteUser(env.DB, telegramId);
    }

    await ctx.editMessageText("✅ اتصال با گوگل‌درایو قطع شد. برای دوباره اتصال /start رو بزن.", {
      reply_markup: new InlineKeyboard(),
    });
  });

  // ── لیست فایل‌ها ────────────────────────────────────────────
  bot.callbackQuery(/^list:(.*)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    // "0" یعنی صفحه‌ی اول (از دکمه‌ی منوی اصلی)، نه یه pageToken واقعی گوگل.
    const raw = ctx.match[1];
    const pageToken = raw && raw !== "0" ? raw : undefined;
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
          reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت"), "menu"),
        });
        return;
      }

      const kb = new InlineKeyboard();
      for (const f of files) {
        kb.text(pad(`📄 ${fileNameLabel(f.name)}`), `file:${f.id}`).row();
      }
      if (nextPageToken) kb.text(pad("➡️ صفحه‌ی بعد"), `list:${nextPageToken}`).row();
      kb.text(pad("🔙 بازگشت"), "menu");

      await ctx.editMessageText("📋 فایل‌های تو در درایو:", { reply_markup: kb });
    } catch (err) {
      console.error("list error:", err);
      await ctx.editMessageText("❌ خطا در دریافت لیست فایل‌ها. دوباره امتحان کن.", {
        reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت"), "menu"),
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
        .text(pad("⬇️ دانلود"), `dl:${fileId}`)
        .row()
        .text(pad("🗑 حذف"), `del:${fileId}`)
        .row()
        .text(pad("🔙 بازگشت به لیست"), "list:0");

      await ctx.editMessageText(
        `📄 ${meta.name}\n${formatSize(meta.size) ? `حجم: ${formatSize(meta.size)}` : ""}`,
        { reply_markup: kb }
      );
    } catch (err) {
      console.error("file detail error:", err);
      await ctx.editMessageText("❌ خطا در دریافت اطلاعات فایل.", {
        reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت"), "list:0"),
      });
    }
  });

  // ── دانلود فایل ────────────────────────────────────────────
  bot.callbackQuery(/^dl:(.+)$/, async (ctx) => {
    const telegramId = ctx.from.id;
    const fileId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: "در حال آماده‌سازی دانلود..." });

    const user = await getUser(env.DB, telegramId);
    if (!user || !ctx.chat) {
      await ctx.reply("❌ مجوز ندارم. لطفاً دوباره /start رو بزن.");
      return;
    }

    try {
      const { accessToken } = await prepareDriveAccess(env, telegramId, user);
      const meta = await getFileMeta(accessToken, fileId);
      const sizeBytes = meta.size ? Number(meta.size) : 0;

      if (sizeBytes > MAX_SEND_BYTES) {
        const linkText = meta.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
        await ctx.editMessageText(
          `📦 این فایل بزرگ‌تر از ${MAX_SEND_BYTES / 1024 / 1024} مگابایته.\n\n🔗 برای دانلود از لینک زیر استفاده کن:\n${linkText}`,
          {
            reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت"), `file:${fileId}`),
          }
        );
        return;
      }

      const bytes = await downloadFileBytes(accessToken, fileId);
      await ctx.replyWithDocument(new InputFile(new Uint8Array(bytes), meta.name));
    } catch (err) {
      console.error("download error:", err);
      await ctx.editMessageText("❌ دانلود ناموفق بود. دوباره امتحان کن.", {
        reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت"), `file:${fileId}`),
      });
    }
  });

  // ── حذف فایل (با تأیید) ────────────────────────────────────
  bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard()
      .text(pad("✅ بله، حذف کن"), `delok:${fileId}`)
      .row()
      .text(pad("🔙 انصراف"), `file:${fileId}`);

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
        reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت به لیست"), "list:0"),
      });
    } catch (err) {
      console.error("delete error:", err);
      await ctx.editMessageText("❌ حذف ناموفق بود. دوباره امتحان کن.", {
        reply_markup: new InlineKeyboard().text(pad("🔙 بازگشت"), `file:${fileId}`),
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
    console.warn(`OAuth error from Google: ${error}`);
    return htmlResponse("اتصال لغو شد", "می‌تونید به تلگرام برگردید و دوباره از /start تلاش کنید.");
  }

  if (!code || !state) {
    console.warn("Missing code or state in OAuth callback");
    return new Response("Missing code/state", { status: 400 });
  }

  // اعتبارسنجی فرمت state (باید UUID باشه)
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(state)) {
    console.warn(`Invalid state format: ${state}`);
    return htmlResponse("خطا", "State نامعتبره.");
  }

  const oauthState = await getOAuthState(env.DB, state);
  if (!oauthState) {
    return htmlResponse("لینک منقضی شده", "لطفاً از تلگرام دوباره روی دکمه‌ی اتصال بزنید.");
  }

  // امنیت: state بیشتر از ۱۰ دقیقه قبل ساخته شده باشه، دیگه معتبر نیست
  const stateAgeMs = Date.now() - new Date(oauthState.created_at + "Z").getTime();
  if (stateAgeMs > 10 * 60 * 1000) {
    await deleteOAuthState(env.DB, state);
    return htmlResponse("لینک منقضی شده", "این لینک قدیمیه. لطفاً از تلگرام دوباره روی دکمه‌ی اتصال بزنید.");
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

async function handleConnectPage(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");

  if (!state || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(state)) {
    return htmlResponse("لینک نامعتبر", "این لینک معتبر نیست. لطفاً از تلگرام دوباره /start را بزنید.");
  }

  const oauthState = await getOAuthState(env.DB, state);
  if (!oauthState) {
    return htmlResponse("لینک منقضی شده", "لطفاً از تلگرام دوباره روی دکمه‌ی اتصال بزنید.");
  }
  const stateAgeMs = Date.now() - new Date(oauthState.created_at + "Z").getTime();
  if (stateAgeMs > 10 * 60 * 1000) {
    await deleteOAuthState(env.DB, state);
    return htmlResponse("لینک منقضی شده", "این لینک قدیمیه. لطفاً از تلگرام دوباره روی دکمه‌ی اتصال بزنید.");
  }

  const googleUrl = buildAuthUrl(env, state);
  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>اتصال به گوگل‌درایو</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 48px 20px;
           background: #0f172a; color: #e2e8f0; max-width: 480px; margin: 0 auto; }
    h1 { color: #e2e8f0; font-size: 1.3rem; }
    p { color: #94a3b8; line-height: 1.8; }
    ul { text-align: right; color: #94a3b8; line-height: 1.9; }
    a.btn { display: inline-block; margin-top: 24px; padding: 14px 28px; background: #22c55e;
            color: #0f172a; font-weight: bold; text-decoration: none; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>🔗 اتصال ربات به حساب گوگل‌درایو شما</h1>
  <p>با کلیک روی دکمه‌ی زیر به صفحه‌ی ورود رسمی گوگل (accounts.google.com) منتقل می‌شوید.</p>
  <ul>
    <li>ربات فقط به پوشه‌ای که خودش در درایو شما می‌سازد دسترسی دارد، نه کل درایو شما.</li>
    <li>می‌توانید هر زمان از منوی ربات (دکمه‌ی «قطع اتصال») دسترسی را لغو کنید.</li>
  </ul>
  <a class="btn" href="${googleUrl}">ادامه به صفحه‌ی ورود گوگل ←</a>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/connect") {
      return handleConnectPage(req, env);
    }

    if (url.pathname === "/oauth/callback") {
      return handleOAuthCallback(req, env);
    }

    if (url.pathname === "/webhook") {
      const bot = createBot(env);
      const handleUpdate = webhookCallback(bot, "cloudflare-mod", {
        secretToken: env.BOT_WEBHOOK_SECRET,
      });
      try {
        return await handleUpdate(req);
      } catch (err) {
        // هر خطای غیرمنتظره‌ای اینجا گیر بیفته، باز هم 200 برمی‌گردونیم.
        // اگه Telegram جواب غیر ۲۰۰ ببینه، همون update رو بارها دوباره
        // می‌فرسته که می‌تونه سیل درخواست/پیام بسازه و ربات رو در معرض
        // فیلتر آنتی‌اسپم تلگرام قرار بده. جواب ۲۰۰ یعنی «دریافت شد»
        // حتی اگه پردازشش داخلی fail شده باشه (که خودش لاگ می‌شه).
        console.error("Webhook top-level error:", err);
        return new Response("ok", { status: 200 });
      }
    }

    if (url.pathname === "/") {
      return new Response("Telegram → Google Drive bot is running.");
    }

    return new Response("Not found", { status: 404 });
  },
};
