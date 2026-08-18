export interface DriveFile {
  id: string;
  webViewLink: string;
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
  fileBytes: ArrayBuffer
): Promise<DriveFile> {
  const boundary = "driveBotBoundary" + crypto.randomUUID().replace(/-/g, "");
  const metadata = JSON.stringify({ name: fileName });
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
