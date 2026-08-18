import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const { PORT = 8080, LOCAL_API_PORT = 8081, SHARED_SECRET } = process.env;

if (!SHARED_SECRET) {
  console.warn("⚠️ SHARED_SECRET تنظیم نشده — هر کسی می‌تونه به این سرویس درخواست بزنه!");
}

function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  if (SHARED_SECRET && header !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// این endpoint فوراً 202 برمی‌گردونه و کار واقعی آپلود در پس‌زمینه ادامه پیدا می‌کنه؛
// نتیجه‌ی نهایی مستقیماً با ویرایش همون پیام تلگرام به کاربر اطلاع داده می‌شه.
app.post("/upload-large", requireAuth, (req, res) => {
  const { fileId, botToken, driveAccessToken, fileName, mimeType, chatId, statusMessageId } =
    req.body || {};

  if (!fileId || !botToken || !driveAccessToken || !fileName || !chatId) {
    return res.status(400).json({ error: "missing required fields" });
  }

  res.status(202).json({ accepted: true });

  processUpload({ fileId, botToken, driveAccessToken, fileName, mimeType, chatId, statusMessageId }).catch(
    (err) => console.error("background upload crashed:", err)
  );
});

async function processUpload({ fileId, botToken, driveAccessToken, fileName, mimeType, chatId, statusMessageId }) {
  const localBase = `http://127.0.0.1:${LOCAL_API_PORT}`;

  try {
    // ۱. گرفتن مسیر فایل از سرور محلی telegram-bot-api (سقف تا ۲ گیگ)
    const fileInfoRes = await fetch(`${localBase}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const fileInfo = await fileInfoRes.json();
    if (!fileInfo.ok) throw new Error(`getFile failed: ${JSON.stringify(fileInfo)}`);

    const filePath = fileInfo.result.file_path;
    const fileSize = fileInfo.result.file_size;

    // ۲. دانلود استریمی فایل از سرور محلی
    const downloadUrl = `${localBase}/file/bot${botToken}/${filePath}`;
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok || !fileRes.body) throw new Error(`telegram download failed: ${fileRes.status}`);

    // ۳. باز کردن یک سشن Resumable Upload در گوگل‌درایو
    const sessionRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${driveAccessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          ...(fileSize ? { "X-Upload-Content-Length": String(fileSize) } : {}),
          ...(mimeType ? { "X-Upload-Content-Type": mimeType } : {}),
        },
        body: JSON.stringify({ name: fileName }),
      }
    );
    if (!sessionRes.ok) throw new Error(`resumable session failed: ${await sessionRes.text()}`);
    const uploadUrl = sessionRes.headers.get("location");
    if (!uploadUrl) throw new Error("Google did not return an upload URL");

    // ۴. استریم مستقیم از تلگرام به گوگل‌درایو، بدون بافر کردن کل فایل در حافظه
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        ...(fileSize ? { "Content-Length": String(fileSize) } : {}),
      },
      body: fileRes.body,
      duplex: "half",
    });
    if (!putRes.ok) throw new Error(`drive upload failed: ${await putRes.text()}`);
    const driveFile = await putRes.json();

    await notifyTelegram(
      botToken,
      chatId,
      statusMessageId,
      `✅ آپلود شد!\n📄 ${fileName}\n🔗 ${driveFile.webViewLink}`
    );
  } catch (err) {
    console.error("upload-large error:", err);
    await notifyTelegram(botToken, chatId, statusMessageId, "❌ آپلود فایل بزرگ ناموفق بود. دوباره امتحان کنید.");
  }
}

async function notifyTelegram(botToken, chatId, statusMessageId, text) {
  const base = `https://api.telegram.org/bot${botToken}`;
  const url = statusMessageId ? `${base}/editMessageText` : `${base}/sendMessage`;
  const body = statusMessageId
    ? { chat_id: chatId, message_id: statusMessageId, text }
    : { chat_id: chatId, text };

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("notifyTelegram failed:", err);
  }
}

app.listen(PORT, () => {
  console.log(`large-file service listening on port ${PORT}`);
});
