# Pool — 多帳號 failover + cooldown

`PoolProvider` 在**同一 provider 的多帳號**間輪替並在暫時性錯誤時 failover。使用方式見 [../README.md](../README.md#pool)。

- **定位**:`createPool({ members })` 回傳一個 `Provider`,用途是多帳號憑證輪替(典型:多個 Claude.ai OAuth 訂閱),**非跨 provider/model 路由**(那是 non-goal)。可直接用,或注入 `createCardan({ providers: { anthropic: pool } })`。混入不同 provider 名稱會 `warnOnce`(model id 原樣送給選中成員,混用幾乎必是設定錯誤)。
- **成員輸入**:`members: (Provider | PoolMember)[]`——直接放裸 provider 實例(weight 1、自動 label),憑證 `.map` 進去即可;要自訂 weight/label 才用 `{ provider, weight?, label? }`。刻意不做 per-provider sugar(`createXxxPool`)或工廠:放寬 `members` 元素型別就涵蓋所有 provider、零新增 API、`pool.ts` 不認識具體 provider。tuning 旋鈕抽成 `PoolBehavior`(= `PoolOptions` 去掉 `members`)作單一真相源。
- **輪替**:建構時依 `weight` 產生固定、均勻交錯的 round-robin 序列(`buildRotation`),每次請求取下一格。
- **pin(`poolMember`)**:請求可用 `GenerateOptions.poolMember` 以 label 指定偏好成員(典型:讓 conversation 黏在持有其 prompt cache 的帳號)。ready 時該成員優先服務;cooling 或 label 不存在則忽略、走正常輪替。pin 若搶走輪替原本要給別人的格子,該成員記一筆**債**,之後的未 pin 請求輪到它時扣債並把它移到嘗試順序尾端(只降優先、不影響 failover 可用性),用量長期保持大致平衡——債有上限(`PIN_DEBT_CAP` × weight),平衡是軟性的。實際服務的成員 label 回報在 `GenerateResult.poolMember` / `finish` 事件的 `poolMember`(未 pin 的請求也回報),呼叫方可據此建立/更新黏著。
- **執行期停用(`setDisabledMembers`)**:以 label 宣告式替換「管理上停用」的成員集合(未知 label 忽略)。停用成員被選擇、failover、全冷卻 last-ditch 一律跳過,pin 到停用成員退回輪替;再呼叫一次即重新啟用。全部成員停用時請求拋 `invalid_request`。典型:管理後台的帳號開關,設定變更時整組重套。
- **failover**:對 `rate_limit | auth | server | network | timeout` 切到下一個**相異**成員重試;池擁有這層跨帳號重試,故嘗試 ≥2 成員時關閉底層 per-attempt retry(只剩一個可試、且非「全部冷卻最後一搏」時保留呼叫方 retry)。全部冷卻的 last-ditch 也關 per-attempt retry,避免長 `Retry-After` 掛住請求。`stream` 只在第一個事件吐出前能切。`maxFailovers` 封頂切換次數,`shouldFailover` 可自訂。
- **cooldown(雙層,依訊號範圍)**:成員失敗後在到期前被後續請求跳過,到期由路由自然刪除解凍,無背景 timer。範圍取決於錯誤訊號:
  - **帳號級**(`resetAt`):絕對 epoch ms、provider 自報精確重置(如訂閱窗口,跨所有 model)→ 冷卻**整個 member**(`memberCooldowns` 以 member index 為 key),所有 model 都跳過,**照值採用、不封頂**。
  - **per-model**(`retryAfterMs`):相對值、可能只限該 model(如 OpenAI TPM)→ 只冷卻 `(member, model)`(`cooldowns` 以 `(member index, model)` 為 key,model 用去前綴裸名);`opus` 被限不影響同帳號 `sonnet`,**封頂 `maxCooldownMs`(預設 15 分鐘)** 防過長/惡意 `Retry-After`。
  - 陳舊(已過期)的 `resetAt` 退回 `retryAfterMs`;兩者皆無 → **不冷卻**,只 failover(偵測不到就不冷卻——瞬時故障未必是帳號問題)。不做預先冷卻。
  - 兩層並存:`coolingUntil` 取兩者中**較晚**的有效到期值判定,純同步、每成員一次 map 查詢、無背景狀態。
- **全部冷卻**:該 model 下所有成員都在冷卻 → 試「最快恢復」的那個作最後一搏(可能已提早重置),仍失敗拋 `rate_limit` `CardanError`(訊息含成員數與最快恢復時間,`retryAfterMs` 設為最快恢復剩餘)。`code` 沿用 `rate_limit`,不新增 `ErrorCode`。
- **不做主動探測 / 預先冷卻**:pool 不持 timer、不主動回查配額、無 usage-aware hook/`onError`。精確 reset 搭在 429 回應上(見 [providers.md#anthropic](./providers.md#anthropic)),到期自然解凍;主動回查 header 還得發真實請求,對 cooling 帳號正是要避免的。早期曾設計 `/api/oauth/usage` 背景探測,因需 `user:profile` scope(inference-only token 403)且需發請求而棄用。
- **`rateLimits()`(純觀測)**:回傳每成員 `{ label, rateLimit }`(各 provider 最後已知額度快照,見 [providers.md#anthropic](./providers.md#anthropic))。pool 刻意**不**據此避讓——仍有額度的成員提前冷卻會浪費配額,與「只在真實錯誤訊號才冷卻」衝突;要不要調權重/降速由呼叫方決定。
