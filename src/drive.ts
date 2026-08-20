export interface DriveFile {
  id: string;
  webViewLink: string;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
}

const FOLDER_NAME = "Telegram Bot Uploads";

/**
 * پوشه‌ی اختصاصی ربات رو در درایو کاربر پیدا می‌کنه؛ اگه نبود می‌سازتش.
 * چون scope ما «drive.file» هست، این جستجو فقط بین فایل‌/پوشه‌هایی می‌گرده که خودِ این اپ ساخته،
 * نه کل درایو کاربر.
 */
export async function getOrCreateFolder(accessToken: string): Promise<string> {
  const query = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)&spaces=drive`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!searchRes.ok) throw new Error(`drive folder search failed: ${await searchRes.text()}`);
  const searchData = await searchRes.json<{ files: { id: string }[] }>();
  if (searchData.files?.length > 0) return searchData.files[0].id;

  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!createRes.ok) throw new Error(`drive folder create failed: ${await createRes.text()}`);
  const created = await createRes.json<{ id: string }>();
  return created.id;
}

/**
 * آپلود multipart (متادیتا + بایت‌های فایل در یک درخواست).
 * چون سقف حجم فایل ما همون ۲۰ مگابایتِ Bot API تلگرامه، بافر کردن کامل فایل
 * در حافظه‌ی Worker (سقف ~۱۲۸ مگابایت) کاملاً امنه و نیازی به resumable upload نیست.
 */
export async function uploadToDrive(
  accessToken: string,
  fileName: string,
  mimeType: string,
  fileBytes: ArrayBuffer,
  folderId?: string
): Promise<DriveFile> {
  const boundary = "driveBotBoundary" + crypto.randomUUID().replace(/-/g, "");
  const metadata = JSON.stringify({ name: fileName, ...(folderId ? { parents: [folderId] } : {}) });
  const encoder = new TextEncoder();

  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(head.length + fileBytes.byteLength + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(fileBytes), head.length);
  body.set(tail, head.length + fileBytes.byteLength);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    throw new Error(`drive upload failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

/** لیست فایل‌های داخل پوشه‌ی اختصاصی ربات (بدون زیرپوشه‌ها، جدیدترین‌ها اول). */
export async function listFilesInFolder(
  accessToken: string,
  folderId: string,
  pageToken?: string
): Promise<{ files: DriveFileMeta[]; nextPageToken?: string }> {
  const query = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({
    q: query,
    fields: "nextPageToken,files(id,name,mimeType,size,webViewLink)",
    orderBy: "createdTime desc",
    pageSize: "20",
    spaces: "drive",
  });
  if (pageToken) params.set("pageToken", pageToken);

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    console.error(`drive list failed (${res.status}): ${await res.text()}`);
    throw new Error(`drive list failed (${res.status})`);
  }
  const data = await res.json<{ files: DriveFileMeta[]; nextPageToken?: string }>();
  return { files: data.files ?? [], nextPageToken: data.nextPageToken };
}

/** متادیتای یک فایل (برای نمایش قبل از دانلود/حذف). */
export async function getFileMeta(accessToken: string, fileId: string): Promise<DriveFileMeta> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,webViewLink`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`drive get meta failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** دانلود بایت‌های فایل از درایو. */
export async function downloadFileBytes(accessToken: string, fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`drive download failed (${res.status}): ${await res.text()}`);
  return res.arrayBuffer();
}

/** حذف فایل از درایو (چون scope ما drive.file هست، فقط فایل‌های ساخته‌شده توسط همین اپ قابل حذفن). */
export async function deleteFile(accessToken: string, fileId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`drive delete failed (${res.status}): ${await res.text()}`);
  }
}
