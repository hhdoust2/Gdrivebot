#!/bin/sh
set -e

if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
  echo "خطا: TELEGRAM_API_ID و TELEGRAM_API_HASH باید تنظیم شده باشن (از my.telegram.org)."
  exit 1
fi

# سرور محلی Bot API رو در پس‌زمینه اجرا می‌کنیم (فقط داخل همین کانتینر در دسترسه، به بیرون expose نمی‌شه)
telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --local \
  --http-port="$TELEGRAM_LOCAL_PORT" \
  --dir=/data/telegram-bot-api \
  --temp-dir=/data/telegram-bot-api/tmp &

# چند ثانیه صبر می‌کنیم تا سرور محلی بالا بیاد
sleep 3

echo "Telegram local Bot API server started on port $TELEGRAM_LOCAL_PORT"

# اپ Node رو روی پورتی که Railway می‌ده (متغیر PORT) اجرا می‌کنیم
exec node server.js
