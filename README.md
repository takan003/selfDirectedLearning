# 自主學習計畫（selfDirectedLearning）

選用功能模組（外掛），掛載於 `campus-toolkit` 主程式。目前**開發中**，尚未建頁。

1. value：`selfDirectedLearning`（全域唯一，決定路由、權限單位與限流／稽核前綴）
2. 狀態：`status: "building"`、`href: ""`（先註冊後實作，路徑未出現即 404）
3. 版本：0.0.1（`contractVersion` 1、`minHostVersion` 0.580）

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

1. `provides` 與四身分頁面範圍
2. `routes`（頁面與 API 掛載點）
3. 權限模型（單一單位或 `managerPermissions` 子權限）
4. `dataCollections` 資料集合、`rateLimits`／`auditActions` 前綴桶
5. 是否使用掛勾（公告 `announcements`／行事曆 `calendar`）
