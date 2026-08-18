# مرحله‌ی اول: فقط برای گرفتن باینری آماده‌ی telegram-bot-api
FROM aiogram/telegram-bot-api:latest AS tba

FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tba /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV LOCAL_API_PORT=8081
EXPOSE 8080

CMD ["./entrypoint.sh"]
