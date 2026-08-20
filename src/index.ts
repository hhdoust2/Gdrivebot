import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import {
  createOAuthState,
  deleteOAuthState,
  deleteUser,
  getOAuthState,
  getUser,
  setUserFolder,
  upsertUserToken,
} from "./db";
import { decrypt, encrypt } from "./crypto";
import { buildAuthUrl, exchangeCodeForTokens, getAccessToken, revokeToken } from "./oauth";
import { getOrCreateFolder, uploadToDrive } from "./drive";

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
  // اختیاری: اگه ست بشه (مثلاً @mychannel)، استفاده از ربات مشروط به عضویت در این کانال می‌شه.
  // ربات باید ادمین همون کانال باشه تا بتونه وضعیت عضویت رو چک کنه.
  // برای غیرفعال‌کردن این قابلیت، فقط این متغیر رو از Secrets حذف/خالی کن — نیازی به تغییر کد نیست.
  CHANNEL_USERNAME?: string;
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

/** آیا کاربر عضو کانال اجباری هست؟ اگه CHANNEL_USERNAME ست نشده باشه، همیشه true. */
async function isChannelMember(env: Env, telegramId: number): Promise<boolean> {
  if (!env.CHANNEL_USERNAME) return true;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(
        env.CHANNEL_USERNAME
      )}&user_id=${telegramId}`
    );
    const data = await res.json<{ ok: boolean; result?: { status: string } }>();
    if (!data.ok || !data.result) return false;
    return ["member", "administrator", "creator"].includes(data.result.status);
  } catch (err) {
    console.error("channel membership check failed:", err);
    // اگه چک fail شد (مثلاً ربات ادمین کانال نیست)، برای جلوگیری از قفل‌کردن کامل ربات، اجازه می‌دیم.
    return true;
  }
}

function joinChannelKeyboard(env: Env): InlineKeyboard {
  const handle = (env.CHANNEL_USERNAME || "").replace(/^@/, "");
  return new InlineKeyboard()
    .url("📢 عضویت در کانال", `https://t.me/${handle}`)
    .row()
    .text("✅ عضو شدم، بررسی کن", "check_membership");
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

  // عضویت اجباری در کانال (اگه CHANNEL_USERNAME تنظیم شده باشه)
  bot.use(async (ctx, next) => {
    if (!env.CHANNEL_USERNAME) {
      await next();
      return;
    }
    const telegramId = ctx.from?.id;
    if (!telegramId) {
      await next();
      return;
    }

    const member = await isChannelMember(env, telegramId);

    if (ctx.callbackQuery?.data === "check_membership") {
      if (member) {
        await ctx.answerCallbackQuery({ text: "✅ عضویت تأیید شد!" });
        await ctx.deleteMessage().catch(() => {});
        // بعد از تأیید، اجازه می‌دیم کاربر دوباره /start بزنه یا فایل بفرسته.
        await ctx.reply("✅ عضویت شما تأیید شد. حالا می‌تونید از ربات استفاده کنید — /start رو بزنید.");
      } else {
        await ctx.answerCallbackQuery({ text: "❌ هنوز عضو کانال نشدی.", show_alert: true });
      }
      return; // این آپدیت اینجا کامل مدیریت شد
    }

    if (!member) {
      await ctx.reply("📢 برای استفاده از ربات، اول باید عضو کانال ما بشی:", {
        reply_markup: joinChannelKeyboard(env),
      });
      return;
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    // فقط برای این‌که منوی دستورات (آیکون کنار جعبه‌ی تایپ) همیشه به‌روز باشه.
    // idempotent هست، صدازدنش چندباره ضرری نداره.
    await ctx.api.setMyCommands([
      { command: "start", description: "شروع / اتصال به گوگل‌درایو" },
      { command: "disconnect", description: "قطع اتصال از گوگل‌درایو" },
    ]);

    const user = await getUser(env.DB, telegramId);
    if (user) {
      await ctx.reply(
        "✅ شما از قبل به گوگل‌درایو متصل هستید. کافیه یه فایل بفرستید تا در درایوتون ذخیره بشه.\n(برای قطع اتصال از منوی دستورات، /disconnect را بزنید.)"
      );
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
      text: "✅ اتصال به گوگل‌درایو با موفقیت انجام شد! از الان هر فایلی که همین‌جا بفرستید، خودکار در پوشه‌ی اختصاصی‌تون در درایو ذخیره می‌شه.",
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

  // نکته: عمداً آدرس accounts.google.com رو مستقیم در HTML نمی‌ذاریم؛ دکمه به یه
  // مسیر داخلی خودمون اشاره می‌کنه که با ریدایرکت سمت سرور (۳۰۲) کاربر رو به گوگل می‌فرسته.
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
  <p>با کلیک روی دکمه‌ی زیر به صفحه‌ی ورود رسمی گوگل منتقل می‌شوید.</p>
  <ul>
    <li>ربات فقط به پوشه‌ای که خودش در درایو شما می‌سازد دسترسی دارد، نه کل درایو شما.</li>
    <li>می‌توانید هر زمان از منوی ربات (دکمه‌ی «قطع اتصال») دسترسی را لغو کنید.</li>
  </ul>
  <a class="btn" href="/go?state=${state}">ادامه به صفحه‌ی ورود ←</a>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** ریدایرکت سمت سرور (نه لینک مستقیم در HTML) به‌سمت صفحه‌ی OAuth گوگل. */
async function handleGoRedirect(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  if (!state || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(state)) {
    return htmlResponse("لینک نامعتبر", "لطفاً از تلگرام دوباره /start را بزنید.");
  }
  const oauthState = await getOAuthState(env.DB, state);
  if (!oauthState) {
    return htmlResponse("لینک منقضی شده", "لطفاً از تلگرام دوباره روی دکمه‌ی اتصال بزنید.");
  }
  const googleUrl = buildAuthUrl(env, state);
  return Response.redirect(googleUrl, 302);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/connect") {
      return handleConnectPage(req, env);
    }

    if (url.pathname === "/go") {
      return handleGoRedirect(req, env);
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
