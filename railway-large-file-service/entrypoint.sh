#!/bin/sh
set -e

if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
  echo "خطا: TELEGRAM_API_ID و TELEGRAM_API_HASH باید تنظیم شده باشن (از my.telegram.org بگیرید)."
  exit 1
fi

mkdir -p /data/telegram-bot-api/tmp

# اجرای سرور محلی Bot API در پس‌زمینه (سقف فایل رو تا ۲ گیگ می‌بره)
telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --http-port="${LOCAL_API_PORT:-8081}" \
  --dir=/data/telegram-bot-api \
  --temp-dir=/data/telegram-bot-api/tmp &

# صبر کوتاه تا سرور محلی بالا بیاد
sleep 3

# سرور Node به‌عنوان پروسه‌ی اصلی (پورتی که Railway بهش ترافیک می‌فرسته)
exec node server.js
