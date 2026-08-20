FROM aiogram/telegram-bot-api:latest AS tgapi

FROM node:20-slim

# باینری telegram-bot-api رو از ایمیج قبلی کپی می‌کنیم (build از سورس خیلی کند و سنگینه)
COPY --from=tgapi /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# دیتای دانلودشده‌ی سرور محلی تلگرام اینجا ذخیره می‌شه
RUN mkdir -p /data/telegram-bot-api

ENV TELEGRAM_LOCAL_PORT=8081
EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
