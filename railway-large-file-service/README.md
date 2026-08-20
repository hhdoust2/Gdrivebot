# سرویس Railway برای فایل‌های بزرگ (بالای ۲۰ مگابایت)

## چرا این سرویس لازمه؟
Bot API عمومی تلگرام (`api.telegram.org`) سقف **۲۰ مگابایت** برای دانلود فایل توسط ربات داره — این یه محدودیت سخته که با هیچ کدی دور زده نمی‌شه، مگر با اجرای **سرور محلی Bot API** (نسخه‌ی متن‌باز خودِ تلگرام) که سقف رو تا ۲ گیگابایت بالا می‌بره. چون این سرور باید دائم روشن باشه، روی Cloudflare Workers (که کوتاه‌مدت و stateless است) قابل‌اجرا نیست — برای همین از Railway (میزبانی کانتینر/سرویس دائمی) استفاده می‌کنیم.

## پیش‌نیاز: گرفتن api_id و api_hash از تلگرام
این با توکن رباتت فرق داره — این مال یه **حساب کاربری** تلگرامه (نه ربات):
1. با گوشی یا مرورگر وارد [my.telegram.org](https://my.telegram.org) شو
2. با شماره‌ی تلفن خودت لاگین کن (پیامک کد میاد)
3. برو به **API development tools**
4. یه اپ جدید بساز (اسم و توضیح دلخواه، مثلاً App title: `MyDriveBot`, Short name: `mydrivebot`)
5. بعد از ساخت، دو مقدار می‌بینی: **App api_id** و **App api_hash** — این‌ها رو نگه دار

⚠️ این‌ها رو مثل رمز عبور محرمانه نگه دار.

## مراحل دیپلوی روی Railway

### ۱. ساخت پروژه
1. وارد [railway.app](https://railway.app) شو (با گیت‌هاب لاگین کن)
2. **New Project → Deploy from GitHub repo**
3. این ریپو (که شامل `Dockerfile`, `server.js`, `entrypoint.sh`, `package.json` است) رو انتخاب کن

### ۲. تنظیم متغیرهای محیطی (Environment Variables)
در تب **Variables** پروژه، این‌ها رو اضافه کن:

| متغیر | مقدار |
|---|---|
| `TELEGRAM_API_ID` | همون api_id که از my.telegram.org گرفتی |
| `TELEGRAM_API_HASH` | همون api_hash |
| `RAILWAY_SHARED_SECRET` | یه رشته‌ی رندوم امن (باید **دقیقاً همون مقداری** باشه که در Cloudflare Secrets به اسم `RAILWAY_SHARED_SECRET` می‌ذاری) |

Railway خودش متغیر `PORT` رو ست می‌کنه؛ نیازی نیست دستی اضافه کنی.

### ۳. اضافه‌کردن یه Volume (مهم!)
چون فایل‌های دانلودشده و موقت باید جایی روی دیسک ذخیره بشن (نه فقط حافظه‌ی موقت کانتینر):
1. در پروژه‌ی Railway، تب **Volumes** یا از تنظیمات سرویس
2. یه Volume جدید بساز و **Mount Path** رو بذار: `/data`
3. این باعث می‌شه فایل‌های موقت بین ری‌استارت‌ها هم پایدار بمونن (و برای فایل‌های خیلی بزرگ، جلوی پرشدن دیسک موقت کانتینر رو می‌گیره)

### ۴. دیپلوی و گرفتن دامنه
بعد از دیپلوی موفق:
1. تب **Settings → Networking → Generate Domain**
2. یه آدرس عمومی می‌گیری، مثلاً: `https://your-service.up.railway.app`

### ۵. وصل‌کردن به ربات (Cloudflare)
در Cloudflare Dashboard → Worker اصلی ربات → Settings → Variables and Secrets:
- `RAILWAY_LARGE_FILE_URL` = `https://your-service.up.railway.app`
- `RAILWAY_SHARED_SECRET` = همون مقداری که در Railway هم گذاشتی (باید عیناً یکی باشن)

## تست
یه فایل بزرگ‌تر از ۲۰ مگابایت به ربات تلگرام بفرست. باید پیام «📤 فایل بزرگه — در پس‌زمینه آپلود می‌شه» رو ببینی، و چند ثانیه تا چند دقیقه بعد (بسته به حجم و سرعت اینترنت)، پیام نهایی با لینک درایو ادیت بشه.

## خطاهای رایج
- **Container crashes on start** → معمولاً یعنی `TELEGRAM_API_ID` یا `TELEGRAM_API_HASH` تنظیم نشده یا اشتباهه
- **401 Unauthorized از Cloudflare به Railway** → `RAILWAY_SHARED_SECRET` در دو طرف یکی نیست
- **فایل هیچ‌وقت آپلود نمی‌شه، پیام هم عوض نمی‌شه** → لاگ‌های Railway (تب Deployments → Logs) رو چک کن؛ معمولاً خطای دسترسی به Google Drive (توکن منقضی) یا خطای local Bot API است
