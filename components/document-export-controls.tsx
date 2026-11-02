"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import type { ToastMessage } from "@/components/Toast";
import { authorizeGoogleDocs, googleOAuth } from "../lib/google-docs-authorization";
import { createGoogleDocument } from "../lib/document-export";
import type { PrintPreviewPayload } from "../types/self-directed-learning";

export default function DocumentExportControls({
  getPayload,
  onToast,
}: {
  getPayload: () => PrintPreviewPayload;
  onToast: (message: ToastMessage) => void;
}) {
  const [payload, setPayload] = useState<PrintPreviewPayload | null>(null);
  const [ready, setReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState<"authorizing" | "creating" | null>(null);
  const [documentUrl, setDocumentUrl] = useState("");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const clientId = (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "").trim();

  useEffect(() => {
    if (!payload) return;
    const dialog = dialogRef.current;
    dialog?.showModal();
    if (googleOAuth()) setReady(true);
    return () => dialog?.close();
  }, [payload]);

  const close = () => {
    if (!busy) setPayload(null);
  };

  const start = () => {
    setAgreed(false);
    setError("");
    setDocumentUrl("");
    setPayload(getPayload());
  };

  const exportDocument = async () => {
    if (!payload || !agreed || busy || !clientId || !ready || scriptFailed) return;
    setError("");
    setBusy("authorizing");
    try {
      const token = await authorizeGoogleDocs(clientId);
      setBusy("creating");
      const url = await createGoogleDocument(payload, token);
      setDocumentUrl(url);
      onToast({ kind: "success", text: "已建立 Google 文件，請按「開啟 Google 文件」開始編輯。" });
    } catch (error) {
      console.error("selfDirectedLearning Google Docs export failed");
      const message = error instanceof Error ? error.message : "Google 文件匯出失敗，請稍後再試。";
      setError(message);
      setAgreed(false);
      onToast({ kind: "error", text: message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <label className="text-t2 flex items-center gap-2 text-xs">
        匯出格式／平台
        <select
          aria-label="匯出格式／平台"
          defaultValue="googleDocs"
          className="input-theme rounded px-2 py-2 text-xs"
        >
          <option value="googleDocs">Google Docs</option>
          <option value="canva" disabled>Canva（下一階段）</option>
          <option value="word" disabled>Word（後續階段）</option>
        </select>
      </label>
      <button type="button" className="btn-theme rounded px-4 py-2 text-xs" onClick={start}>
        匯出
      </button>
      {payload && (
        <dialog
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="匯出至 Google Docs"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          className="border-themed bg-card text-t1 max-w-xl overflow-y-auto rounded-lg border p-4 shadow-lg"
          style={{ margin: "auto", width: "calc(100% - 2rem)", maxHeight: "85dvh" }}
        >
          <h2 className="text-lg font-semibold">匯出至 Google Docs</h2>
          <p className="text-t2 mt-2 break-words text-sm">{payload.topic || "未命名計畫"}</p>
          <p className="text-t2 mt-2 text-sm">
            將此刻的學生姓名、班級、計畫、逐週成果及心得（包含畫面中尚未儲存的內容），
            建立為你選擇的 Google 帳號中的可編輯副本。請選擇自己的帳號。
            不會自動公開分享，也不會把外部修改同步回校內。
          </p>
          <p className="text-t3 mt-2 text-xs">
            僅要求此應用程式建立／開啟之檔案的存取權，不讀取整個雲端硬碟。
            每次操作會建立新副本，文字格式、表格或分頁可能與列印預覽略有不同。
          </p>
          {!clientId ? (
            <p role="alert" className="text-danger mt-3 text-sm">
              尚未設定 NEXT_PUBLIC_GOOGLE_CLIENT_ID，請由學校管理員完成 Google OAuth 與 Drive API 設定。
            </p>
          ) : !documentUrl && (
            <Script
              id="sdl-google-docs-identity"
              src="https://accounts.google.com/gsi/client"
              onReady={() => {
                const available = Boolean(googleOAuth());
                setReady(available);
                setScriptFailed(!available);
              }}
              onError={() => {
                setScriptFailed(true);
                setReady(false);
              }}
            />
          )}
          {scriptFailed && (
            <p role="alert" className="text-danger mt-3 text-sm">
              無法載入 Google 授權元件，請檢查網路或內容阻擋設定，重新整理後再試。
            </p>
          )}
          {error && <p role="alert" className="text-danger mt-3 text-sm">{error}</p>}
          {!documentUrl && (
            <label className="border-themed mt-3 flex items-start gap-2 rounded border p-3 text-sm">
              <input
                type="checkbox"
                checked={agreed}
                disabled={Boolean(busy)}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>我同意將上述資料傳送至本人選擇的 Google 帳號，建立此次文件副本。</span>
            </label>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" disabled={Boolean(busy)} className="btn-theme rounded px-4 py-2 text-sm disabled:opacity-50" onClick={close}>
              {documentUrl ? "關閉" : "取消"}
            </button>
            {documentUrl ? (
              <a href={documentUrl} target="_blank" rel="noopener noreferrer" className="btn-primary rounded px-4 py-2 text-sm">
                開啟 Google 文件
              </a>
            ) : (
              <button
                type="button"
                className="btn-primary rounded px-4 py-2 text-sm disabled:opacity-50"
                disabled={!clientId || !ready || scriptFailed || !agreed || Boolean(busy)}
                onClick={() => void exportDocument()}
              >
                {busy === "authorizing" ? "等待 Google 授權…" : busy === "creating" ? "建立文件中…" : ready ? "選擇 Google 帳號並建立" : "載入 Google 授權元件…"}
              </button>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
