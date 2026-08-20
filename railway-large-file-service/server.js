const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TELEGRAM_LOCAL_PORT = process.env.TELEGRAM_LOCAL_PORT || 8081;
const SHARED_SECRET = process.env.RAILWAY_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.error("خطا: RAILWAY_SHARED_SECRET تنظیم نشده.");
  process.exit(1);
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => res.send("Railway large-file service is running."));

// نکته: سریع ۲۰۲ برمی‌گردونیم و کار سنگین (دانلود+آپلود) رو در پس‌زمینه انجام می‌دیم،
// چون Cloudflare Worker منتظر جواب سریع می‌مونه، نه کل فرآیند.
app.post("/upload-large", requireAuth, (req, res) => {
  const { fileId, botToken, driveAccessToken, fileName, mimeType, chatId, statusMessageId, folderId } =
    req.body || {};

  if (!fileId || !botToken || !driveAccessToken || !fileName || !chatId) {
    return res.status(400).json({ error: "missing required fields" });
  }

  res.status(202).json({ ok: true, message: "processing started" });

  // پردازش در پس‌زمینه (بعد از ارسال جواب)
  processLargeFile({ fileId, botToken, driveAccessToken, fileName, mimeType, chatId, statusMessageId, folderId }).catch(
    (err) => console.error("processLargeFile error:", err)
  );
});

async function processLargeFile({
  fileId,
  botToken,
  driveAccessToken,
  fileName,
  mimeType,
  chatId,
  statusMessageId,
  folderId,
}) {
  let localFilePath;
  try {
    // ۱. از سرور محلی Bot API بخواه فایل رو دانلود کنه (سقف تا ۲ گیگابایت، نه ۲۰ مگابایت)
    localFilePath = await getFileViaLocalApi(botToken, fileId);

    // ۲. آپلود resumable به گوگل‌درایو (برای فایل‌های بزرگ، مطمئن‌تر از یه درخواست massive)
    const driveFile = await uploadToDriveResumable(driveAccessToken, localFilePath, fileName, mimeType, folderId);

    // ۳. اطلاع به کاربر در تلگرام (از API عمومی، چون فقط متنه، محدودیت حجم نداره)
    await telegramEditMessage(
      botToken,
      chatId,
      statusMessageId,
      `✅ آپلود فایل بزرگ کامل شد!\n📄 ${fileName}\n🔗 ${driveFile.webViewLink}`
    );
  } catch (err) {
    console.error("large file processing failed:", err);
    await telegramEditMessage(
      botToken,
      chatId,
      statusMessageId,
      "❌ آپلود فایل بزرگ ناموفق بود. لطفاً دوباره امتحان کنید."
    ).catch(() => {});
  } finally {
    if (localFilePath) {
      fs.unlink(localFilePath, () => {}); // پاک‌سازی فایل موقت، بدون توقف روی خطا
    }
  }
}

/** از سرور محلی Bot API می‌خواد فایل رو دانلود کنه؛ چون --local فعاله، مسیر فایل روی دیسک همین کانتینر برمی‌گرده. */
async function getFileViaLocalApi(botToken, fileId) {
  const getFileRes = await fetch(
    `http://localhost:${TELEGRAM_LOCAL_PORT}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const getFileData = await getFileRes.json();
  if (!getFileData.ok) throw new Error(`local getFile failed: ${JSON.stringify(getFileData)}`);

  const filePath = getFileData.result.file_path;
  // با --local، file_path یه مسیر واقعی روی دیسک همین کانتینره (نه یه URL که باید دوباره دانلود بشه)
  if (!fs.existsSync(filePath)) {
    throw new Error(`local file not found at ${filePath}`);
  }
  return filePath;
}

/** آپلود resumable به گوگل‌درایو — مناسب فایل‌های بزرگ (چند مرحله‌ای، مقاوم در برابر قطعی). */
async function uploadToDriveResumable(accessToken, localFilePath, fileName, mimeType, folderId) {
  const stat = fs.statSync(localFilePath);
  const metadata = { name: fileName, ...(folderId ? { parents: [folderId] } : {}) };

  // مرحله ۱: باز کردن یه session آپلود resumable
  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType || "application/octet-stream",
        "X-Upload-Content-Length": String(stat.size),
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) throw new Error(`resumable init failed (${initRes.status}): ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("no resumable upload URL returned");

  // مرحله ۲: آپلود کل بایت‌ها (Node می‌تونه stream کنه، فایل کامل تو حافظه لود نمی‌شه)
  const stream = fs.createReadStream(localFilePath);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(stat.size),
      "Content-Type": mimeType || "application/octet-stream",
    },
    // @ts-ignore - Node fetch duplex requirement for streaming bodies
    duplex: "half",
    body: stream,
  });
  if (!uploadRes.ok) throw new Error(`resumable upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  return uploadRes.json();
}

async function telegramEditMessage(botToken, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
}

app.listen(PORT, () => {
  console.log(`Large-file service listening on port ${PORT}`);
});
