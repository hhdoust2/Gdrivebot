# ربات تلگرام → گوگل‌درایو

ربات تلگرامی که هر کاربر با حساب گوگل‌درایوِ خودش (نه یک اکانت مشترک) وصل می‌شه و فایل‌هایی که در تلگرام
می‌فرسته به‌صورت خودکار در درایوش آپلود می‌شن.

**استک:** TypeScript + [grammY](https://grammy.dev) روی **Cloudflare Workers**، ذخیره‌سازی توکن‌ها در **Cloudflare D1**.

**محدودیت مهم:** سقف حجم فایل **۲۰ مگابایت** است — این محدودیتِ Bot API عمومی تلگرامه، نه محدودیت این پروژه.
برای عبور از این سقف باید یا یک سرور دائمی (Local Bot API Server) اجرا کنید یا از MTProto استفاده کنید که
هر دو نیازمند زیرساخت متفاوتی از سرورلس هستن.

---

## ۱. پیش‌نیازها

- حساب [Cloudflare](https://dash.cloudflare.com) (رایگان)
- حساب [Google Cloud](https://console.cloud.google.com) (رایگان)
- Node.js نسخه ۱۸ به بالا
- دستور `npm install -g wrangler` (یا استفاده از `npx wrangler`)

## ۲. ساخت ربات تلگرام

1. در تلگرام به [@BotFather](https://t.me/BotFather) پیام بدید و `/newbot` بزنید.
2. یک نام و یوزرنیم انتخاب کنید. توکن (`BOT_TOKEN`) رو نگه دارید.

## ۳. ساخت پروژه در Google Cloud

1. یک پروژه جدید در [Google Cloud Console](https://console.cloud.google.com) بسازید.
2. از منوی **APIs & Services → Library**، سرویس **Google Drive API** رو فعال کنید.
3. به **APIs & Services → OAuth consent screen** برید:
   - نوع را **External** انتخاب کنید.
   - اسکوپ `.../auth/drive.file` رو اضافه کنید.
   - در حالت Testing، ایمیل کاربرانی که قراره از ربات استفاده کنن رو به‌عنوان Test User اضافه کنید
     (تا زمانی که اپ رو Verify نکردید، فقط همین کاربران می‌تونن وصل بشن).
4. به **APIs & Services → Credentials** برید و یک **OAuth client ID** از نوع **Web application** بسازید.
   - در **Authorized redirect URIs** آدرس زیر رو اضافه کنید (بعد از دیپلوی، دامنه واقعی Worker رو جایگزین کنید):
     ```
     https://telegram-drive-bot.YOUR-SUBDOMAIN.workers.dev/oauth/callback
     ```
   - `Client ID` و `Client Secret` رو نگه دارید.

## ۴. نصب وابستگی‌ها

```bash
cd telegram-drive-bot
npm install
```

## ۵. ساخت دیتابیس D1

```bash
npx wrangler login
npx wrangler d1 create drive-bot-db
```

خروجی این دستور یک `database_id` می‌ده — اون رو داخل `wrangler.toml` جای `REPLACE_WITH_YOUR_DATABASE_ID`
بذارید. سپس اسکیمای دیتابیس رو اجرا کنید:

```bash
npm run db:init:remote
```

## ۶. ساخت کلید رمزنگاری

```bash
openssl rand -base64 32
```

خروجی رو به‌عنوان `ENCRYPTION_KEY` نگه دارید (برای رمزنگاری refresh tokenهای کاربران در دیتابیس استفاده می‌شه).

## ۷. تنظیم متغیرهای محیطی (Secrets)

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put BOT_WEBHOOK_SECRET   # یک رشته‌ی تصادفی دلخواه بسازید، مثلاً با: openssl rand -hex 24
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ENCRYPTION_KEY
```

همچنین `BASE_URL` را در `wrangler.toml` (بخش `[vars]`) با آدرس واقعی Workerتون آپدیت کنید
(بعد از اولین دیپلوی، این آدرس رو از Cloudflare می‌گیرید).

برای تست محلی، فایل `.dev.vars.example` رو کپی کنید به `.dev.vars` و مقادیر واقعی رو بذارید.

## ۸. دیپلوی

```bash
npm run deploy
```

آدرس Worker رو از خروجی (چیزی شبیه `https://telegram-drive-bot.xxx.workers.dev`) کپی کنید و:

- در `wrangler.toml`، مقدار `BASE_URL` رو با همین آدرس آپدیت و دوباره `npm run deploy` بزنید.
- در Google Cloud Console، همین آدرس + `/oauth/callback` رو به Authorized redirect URIs اضافه کنید.

## ۹. تنظیم Webhook تلگرام

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://telegram-drive-bot.YOUR-SUBDOMAIN.workers.dev/webhook",
    "secret_token": "<BOT_WEBHOOK_SECRET>"
  }'
```

جای `<BOT_TOKEN>` و `<BOT_WEBHOOK_SECRET>` مقادیر واقعی خودتون رو بذارید.

## ۱۰. تست

در تلگرام به ربات‌تون `/start` بزنید، روی دکمه‌ی اتصال به گوگل‌درایو بزنید، مجوز بدید، و بعد یک فایل
(حداکثر ۲۰ مگابایت) بفرستید. باید لینک فایل آپلودشده در درایوتون رو دریافت کنید.

---

## دیپلوی روی GitHub (اتصال خودکار)

می‌تونید ریپو رو به GitHub پوش کنید و از Cloudflare Dashboard → Workers & Pages → Create →
**Connect to Git** استفاده کنید تا هر push به شاخه‌ی اصلی، به‌صورت خودکار دیپلوی بشه. Secretها رو
هم از همون Dashboard (Settings → Variables and Secrets) تنظیم کنید.

## نکات امنیتی

- Refresh tokenها هرگز به‌صورت خام ذخیره نمی‌شن؛ با AES-GCM رمزنگاری می‌شن.
- Scope گوگل روی `drive.file` محدود شده — یعنی ربات فقط به فایل‌هایی که خودش آپلود کرده دسترسی داره،
  نه به کل درایوی کاربر.
- Webhook تلگرام با `secret_token` تایید می‌شه تا کسی نتونه پیام جعلی به Worker بفرسته.
- برای قطع دسترسی، کاربر می‌تونه `/disconnect` بزنه (یا از تنظیمات گوگل، دسترسی اپ رو لغو کنه).
