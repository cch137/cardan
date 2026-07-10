# 長請求與斷線(streaming / background)

- **問題**:高 reasoning effort(`high`/`xhigh`/`max`)請求耗時長,單一長 HTTP 連線易被中間層 idle timeout 砍。各供應商官方建議一致:**長請求不要用單一非串流請求**。
- **主線解法(跨供應商、預設):streaming**。連線持續吐事件把 socket 保溫——高 effort 時 cardan 已帶 reasoning summary(OpenAI 系 `summary: "auto"`),thinking deltas 思考期間就流出,無長靜默。六家唯一一致的防斷線手段,cardan 已具備(`stream()` + `collectStream`)。**會斷的是非串流 `generate()`**;長/高 effort 應走 `stream()`。`generate()` 維持原狀(短請求便利原語),不內部改走串流端點。
- **background 模式(OpenAI Responses only,已實作)**:`GenerateOptions.background` 三態——`undefined`(預設)為 **auto**(effort `high`/`xhigh`/`max` 自動開,否則關),`true`/`false` 強制。**background ≠ batch**:它**立刻以正常優先序執行**(極短排隊),純粹解耦「執行」與「HTTP 連線」——連線斷了工作仍在 server 跑,幾乎不增延遲。
  - **`store` 連動**:background 強制 `store: true`(否則無法輪詢/取回),覆蓋預設 `store: false`;`include: ["reasoning.encrypted_content"]` 照送,thinking 仍從 `messages` 重放,與 stateless 路徑一致。可用 `providerOptions` 覆寫。background 不相容 ZDR、資料僅留約 10 分鐘。
  - **`generate`**:POST 建立後拿 `id`,固定間隔 GET `/v1/responses/{id}` 輪詢,離開 `queued`/`in_progress` 即解析終態。輪詢總時長由 `signal` 約束(無內建上限)。
  - **`stream`**:POST 開 `background: true` + `stream: true` 的 SSE;連線中途斷(讀取錯誤或無 `response.completed`)時,以 GET `/v1/responses/{id}?stream=true&starting_after=<sequence_number>` **透明續流**,對呼叫端仍是單一事件流。只在連線層級中斷(network)續接;auth/server/`abort` 不續、直接拋。續接次數有上限。
  - **xAI 不支援**:xAI Responses 雖線上相容,但實測拒收 `background`(`Argument not supported: background`),故 `XAIProvider` 覆寫 `resolveBackground()` 恆回 `false`,永不送出 `background`/`store: true`;xAI 高 effort 防斷線只能靠 streaming。
- **不做跨供應商統一抽象**:只有 OpenAI Responses 有「即時、與連線解耦」的 background,故只這家實作,其餘(含 xAI)忽略 `background`。xAI 另有 **Deferred Chat Completions**(`deferred: true`→`request_id`→poll `/v1/chat/deferred-completion/{id}`)但走 Chat Completions 端點(非 cardan xAI 用的 Responses),不採用;Anthropic/Gemini/Groq **無**即時 background,只有 Batch,防斷線只能靠 streaming。
- **Batch API 維持範圍外**:Batch(Anthropic Message Batches、Gemini/Groq/xAI Batch)是**吞吐導向**——離峰處理、best-effort 約 24h SLA、半價,延遲高且不可控。與 background「即時執行、只解耦連線」相反,**不能防斷線**;語意與 `generate`/`stream` 完全不同。需要時上層應用直接打供應商 Batch 端點,cardan 不封裝。
