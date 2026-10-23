# 自主學習計畫（selfDirectedLearning）

選用功能模組（外掛），掛載於 `campus-toolkit` 主程式。目前**開發中**，尚未建頁。

1. value：`selfDirectedLearning`（全域唯一，決定路由、權限單位與限流／稽核前綴）
2. 狀態：`status: "building"`、`href: ""`（先註冊後實作，路徑未出現即 404）
3. 版本：0.0.1（`contractVersion` 1、`minHostVersion` 0.580）
4. 需求背景：108 課綱自主學習計畫——學校每週提供 1–3 節彈性學習時間，學生自行訂定
   1 學期 21 或 22 週以內的學習方案，可安排於彈性學習時間或課餘完成，得邀請學校教師
   或相關領域人士擔任指導教師；於彈性學習時間實施時，地點須在學校規範內。
5. 開發規劃書：`docs/開發規劃書.md`（身分權限定案、待定案清單）

## 開發環境

1. 本機路徑：`D:\workspace\CT\selfDirectedLearning`（宿主 `campus-toolkit` 同區並列）。
2. 掛載（宿主目錄執行，掛載前先停 dev server）：

   ```bash
   npm run module:link -- D:\workspace\CT\selfDirectedLearning --copy --watch
   ```

3. 驗 `module.lock.json` 的 `"source"` 為 `link-copy:`；驗收基準＝API 未登入回 401 而非 Build Error。

## 撰寫規範

撰寫前說明書見宿主 `docs/選用功能模組開發者指南.md`（骨架範例、公開面白名單、UI／
資料庫契約、錯誤對照表）；契約規格見 `docs/主程式模組與功能模組.md`。

## 待定案

1. ~~`provides` 與四身分頁面範圍~~（已定案：學生、家長、教職員勾選入口；管理端暫啟用）
2. ~~`routes`、權限模型、`dataCollections`、掛勾~~（已定案，見 `docs/開發規劃書.md` 第四章）
3. 流程細節的畫面與資料結構（節次行程、開放場域、審核人員欄位）
4. 導師↔班級資料來源查證；匯出與省流閘門；契約測試 `tests/contract/`
