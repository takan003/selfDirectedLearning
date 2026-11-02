import { sanitizeRichHtml, type PrintPreviewPayload } from "../types/self-directed-learning";

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DOCS_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function richText(value: string): string {
  return sanitizeRichHtml(value).replace(/\r?\n/g, "<br>");
}

export function documentTitle(payload: PrintPreviewPayload): string {
  return `自主學習計畫－${payload.topic.trim() || "未命名"}－${payload.period}`.slice(0, 200);
}

/** 外部編輯副本只含學生主動匯出的內容，不含帳號、審查意見或系統內部識別碼。 */
export function buildDocumentHtml(payload: PrintPreviewPayload): string {
  const rows = payload.weeks.map((week) => {
    const record = payload.layout === "integrated" && week.record
      ? `<h3>執行成果紀錄</h3>${richText(week.record)}`
      : "";
    return `<tr><td>第 ${week.week} 週<br>${week.timing === "afterSchool" ? "課餘" : "彈性學習"}</td><td>${richText(week.content)}${record}</td><td>${escapeText(week.venue)}</td></tr>`;
  }).join("");
  const records = payload.layout === "separate"
    ? payload.weeks.filter((week) => week.record).map((week) =>
        `<h3>第 ${week.week} 週</h3>${richText(week.record)}`
      ).join("")
    : "";
  const source = payload.source === "draft"
    ? "草稿副本"
    : payload.formalByStudent ? "學生自行提升之正式計畫副本" : "學校審核通過之計畫副本";
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${escapeText(documentTitle(payload))}</title></head><body>
<h1>自主學習計畫</h1>
<p>${escapeText(payload.period)} 學期・${source}</p>
<p>學生：${escapeText(payload.studentName)}　班級：${escapeText(payload.className)}</p>
<p>主題：${escapeText(payload.topic)}</p>
<p>學群：${escapeText(payload.studyGroup)}　指導老師：${escapeText(payload.advisor || "未指定")}</p>
<h2>學習目標</h2>${richText(payload.learningGoals)}
<table border="1" style="border-collapse:collapse;width:100%"><thead><tr><th>週次</th><th>學習安排</th><th>場地</th></tr></thead><tbody>${rows}</tbody></table>
${records ? `<h2>執行成果紀錄</h2>${records}` : ""}
${payload.reflection ? `<h2>學習反思心得</h2>${richText(payload.reflection)}` : ""}
<p>本文件為匯出當下的編輯副本；外部修改不會同步或覆蓋校內計畫。</p>
</body></html>`;
}

export function buildGoogleDocsUpload(payload: PrintPreviewPayload, boundary: string): Blob {
  const metadata = JSON.stringify({
    name: documentTitle(payload),
    mimeType: "application/vnd.google-apps.document",
  });
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${buildDocumentHtml(payload)}\r\n`,
    `--${boundary}--\r\n`,
  ], { type: `multipart/related; boundary=${boundary}` });
}

export async function createGoogleDocument(
  payload: PrintPreviewPayload,
  accessToken: string
): Promise<string> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(GOOGLE_DOCS_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: buildGoogleDocsUpload(payload, `sdl-${crypto.randomUUID()}`),
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("Google 授權已失效，請重新授權後匯出。");
      if (response.status === 403) {
        throw new Error("Google 拒絕建立文件：請確認已啟用 Drive API、同意檔案權限，且學校允許此應用程式。");
      }
      if (response.status === 429) throw new Error("Google 請求過於頻繁，請稍後再試。");
      throw new Error(`Google 文件建立失敗（HTTP ${response.status}），請先確認雲端硬碟是否已有副本，再決定是否重試。`);
    }
    const result: unknown = await response.json();
    if (
      !result || typeof result !== "object" || !("id" in result) ||
      typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)
    ) {
      throw new Error("Google 未回傳有效文件連結；文件可能已建立，請先檢查自己的雲端硬碟，避免重複匯出。");
    }
    return `https://docs.google.com/document/d/${result.id}/edit`;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("建立文件逾時，請先檢查 Google 雲端硬碟是否已有副本，避免重複匯出。");
    }
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new Error("無法確認 Google 文件建立結果，請檢查網路並先查看自己的雲端硬碟，再決定是否重試。");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
