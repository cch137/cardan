# cardan — 核心設計

統一各大 LLM 供應商 API 的 TypeScript adapter 庫。發佈到 npm,供 Deno(`npm:cardan`)與 Node 使用。各供應商 wire 細節見 [providers.md](./providers.md);Pool、streaming/background、web search、Conversation/Agent 各有專文([docs 索引](./README.md))。

## 動機

- raven 已有自寫的 provider 抽象(`lib/utils/ai/`),但綁死 raven repo,kairos、ticks 無法用。
- 不信任 aggregator 套件的供應鏈:**不依賴 `ai`(Vercel AI SDK)、`litellm`、`langchain` 及其生態**。依賴樹龐大、更新頻繁、第三方統一封裝所有供應商,單點被攻破影響面太大。
- 自有 schema 讓 usage 記帳、訊息儲存、跨供應商切換不受上游 breaking change 牽制。

## 設計原則

1. **照官方文檔直接構建 adapter**,預設以原生 `fetch` 發 HTTP;HTTP 實作明顯不切實際時才逐案引入第一方 SDK。
2. **零執行期依賴**——供應鏈安全的最強保證,也是本庫核心理由。唯一例外 zod(optional peerDependency),不用 zod 仍零依賴。
3. **自有通用 schema**:message、tool、usage 等核心型別由 cardan 定義,各 adapter 雙向轉換供應商格式。
4. **簡單高效**:不做用不到的抽象;每供應商一檔案/目錄,新增供應商不動核心。
5. **預留擴展**:schema 預留欄位(新 content 類型、新 usage 細項),不預先實作。

## Goals

- 統一 `generate`(含 streaming)介面:多輪訊息、system prompt、tool calling、structured output(JSON Schema)、reasoning/thinking、vision、內置 web search。
- 統一 usage schema:input/output token 總量 + 細項(cache read/write、reasoning 等),足以記帳。
- 統一錯誤分類(auth、rate limit、overloaded、context length、invalid request、network),可重試錯誤自動退避,尊重 `Retry-After`。
- 統一 streaming 事件流(AsyncIterable),事件種類最小化。
- Embeddings(僅限有提供的供應商)。
- 跑在 Node ≥ 20 與 Deno;只用 Web 標準(`fetch`/`AbortSignal`),天然支援 edge runtime。

## Non-goals

- **不做重 agent framework**:提供輕量 `Agent`(可複用身份 + 可選 memory + tool 迴圈),不做 planning、vector memory/RAG、編排引擎、durable runtime;編排用原生 async + `parallel`。
- **不做 prompt 管理**:無模板、無 registry。
- **不做 RAG**:無 vector store、無 chunking。
- **不做 gateway/proxy**:cardan 是 client 端庫,不是服務。
- **不做跨供應商自動 fallback/路由**:呼叫方自選 model;model→provider 路由是上層職責。(`PoolProvider` 是**同一 provider 多帳號輪替 + failover**,非跨 provider 路由——見 [pool.md](./pool.md)。)
- **不追求覆蓋所有供應商**:只支援下方分級清單,新增需有實際需求。
- **不重發明 SDK 全部功能**:files、batch、fine-tuning 等管理面不在範圍,除非未來有需求。

## 供應商分級

### 第一梯隊:最高優先度,確保功能完善

| 供應商 | 文檔入口 | 備註 |
| --- | --- | --- |
| Anthropic Claude | <https://platform.claude.com/llms.txt> | |
| OpenAI | <https://developers.openai.com/llms.txt> | 使用 **Responses API**(不用 Chat Completions) |
| Google Gemini | <https://ai.google.dev/gemini-api/docs/llms.txt> | |

### 第二梯隊:維持正常運行

| 供應商 | 文檔入口 | 備註 |
| --- | --- | --- |
| xAI Grok | <https://docs.x.ai/llms.txt> | |
| Groq | <https://console.groq.com/llms.txt> | |

### 第三梯隊:不常用的供應商

| 供應商 | 文檔入口 | 備註 |
| --- | --- | --- |
| Modal | <https://modal.com/llms.txt> | 自部署模型,OpenAI 相容端點 |

分級含義:第一梯隊功能缺口視為 bug;第二梯隊保證基本 generate/streaming/tools 可用;第三梯隊盡力而為,壞了再修。

## 核心抽象(示意,非最終 API)

```ts
// 訊息:role + content parts,所有供應商格式都轉換自/至這個形狀
type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: Uint8Array | URL }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; result: unknown; isError?: boolean }
  | { type: "thinking"; text: string; signature?: string };

// usage:總量 + 供應商細項,缺漏欄位一律視為 0
type Usage = {
  input: { total: number; details: Record<string, number> };  // e.g. cache_read, cache_write
  output: { total: number; details: Record<string, number> }; // e.g. reasoning
};

// streaming 事件(最小集合)
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "finish"; reason: FinishReason; usage: Usage };
```

設計約束:

- assistant 回合的 tool calls 與其 `tool_result` 在 schema 層配對,各 adapter 映射到供應商格式(Anthropic content blocks、OpenAI Responses items、Gemini parts)。
- 供應商獨有能力(Anthropic prompt caching、OpenAI reasoning effort)透過 per-provider options 透傳,不汙染通用 schema。
- **模型差異由 adapter 的 per-model 能力表吸收**,非呼叫方必填知識。通用 schema 允許 system 訊息在任何位置;無法表達的由 adapter 自動降轉(Anthropic system 是 top-level 參數,adapter hoist;不支援中段 system 的模型併入相鄰 user 訊息)。options 是覆寫逃生口。
- **訊息序列正規化**:部分供應商強制 user/assistant 交錯、或要求 tool_result 緊跟對應 tool_call。adapter 送出前自動合併連續同 role、把 tool_result 重排到對應 call 之後;懸空 tool_call 補錯誤 result(見下)。
- **tool call ID 保真**:供應商 call id(OpenAI `call_…`、Anthropic `toolu_…`)原樣保存、回送同供應商原樣使用,絕不重生成。跨供應商重放由 adapter 重映射,但 call/result 配對須維持。
- 錯誤統一為帶 `code` 的 error class,保留原始 response。

## 技術決策

- **ESM only**,TypeScript 編譯產出 `dist/`(tsdown),`exports` 單一入口;adapter 是否拆 subpath(`cardan/anthropic`)待 API 成形再定。
- **認證**:API key 由呼叫方顯式傳入,也支援讀各供應商慣例環境變數;cardan 不儲存/管理 key。
- **重試**:預設對 429/5xx/網路錯誤做有上限指數退避,可關閉;取消用 `AbortSignal`。
- **逾時**:`timeoutMs`(per-request 或 `ProviderOptions` 預設,per-request 優先)限**每次 HTTP 嘗試**(重試重置);`undefined`/`0`(預設)為**不逾時**——LLM 高 effort 耗時不可預測,硬塞預設易誤砍(刻意異於 OpenAI/Anthropic SDK)。逾時拋**可重試** `CardanError`(`code:"timeout"`),與 caller `signal` 取消(`code:"aborted"`,不重試)區分。語意錨在「回應開始(headers 到達)」:非串流 `generate` 等同整體生成上限,串流只約束連線建立(中途卡住用 `signal`)。實作:各 provider `request()` 以 `withTimeoutSignal` 合成 caller signal + timer,靠 fetch 以 `signal.reason` 拒絕讓錯誤浮現。硬性總上限用 `signal: AbortSignal.timeout(ms)`;串流 idle-timeout 與總 deadline 不內建(v1)。
- **模型識別與路由**:統一入口用 `provider/model` 字串(`openai/gpt-5.5`),**只切第一個 `/`**——前段是 provider,其餘原樣傳供應商(模型名可含 `/`,如 `groq/meta-llama/llama-4-scout`),adapter 收不帶前綴的名。不 hard-code 封閉模型集合(維護成本高、落後上游);型別層用 template literal + `(string & {})` 給已知模型 autocomplete。**autocomplete 只列前沿模型**:同價位有更好替代品則舊型號不列(`(string & {})` 仍接受任何字串);測試亦只用前沿模型,唯負向測試(驗證能力缺失)保留舊模型作 fixture。
- **zod 支援**:optional peerDependency(`zod@^4`)。tools 與 structured output 的 schema 接受純 JSON Schema 或 zod schema;zod 用 `.parse()` 驗證回應、用 `z.toJSONSchema` 轉換(動態 import,僅呼叫方傳 zod 時觸發)。cardan 內部解析回應不用 zod,維持 TypeScript 型別 + 防禦性解析。
- **測試**:核心轉換(message/usage/stream 雙向映射、序列正規化)用 fixture 單元測試;真實 API smoke test 獨立成手動腳本,不進 CI。

## 開放問題

- [ ] raven `lib/utils/ai/` 與 ticks 的 Vercel AI SDK 何時遷移到 cardan;遷移前 API 視為不穩定(0.x)。

## 已決議(schema / 通用機制)

各供應商特定的 wire 決策見 [providers.md](./providers.md)。

- runtime 驗證:供應商回應不引入 schema 庫,用 TypeScript 型別 + 防禦性解析;zod 僅作呼叫方 schema 輸入(optional peerDependency)。
- 懸空 tool_call:補錯誤 result(`isError: true`,內容 "tool call produced no result"),讓中斷對話可重放;孤兒/重複 tool_result 報 `invalid_request`。
- `StreamEvent` 在最小集合外加 `thinking_signature`(thinking block 關閉時帶重放簽章),否則 streaming 的 thinking 無法在多輪 tool use 回送。
- `ThinkingPart` 加 `redacted?: boolean` 表達 Anthropic `redacted_thinking`(signature 欄位存不透明 data)。
- `ThinkingPart` 加 `id?: string`(stream `thinking_signature` 事件同步加 optional `id`),承載 OpenAI reasoning item id(`rs_…`);stateless 重放需 `id` + `encrypted_content`(存進 `signature`)兩者,缺一即丟棄該 part。
- `TextPart`/`ToolCallPart` 加 `signature?: string`(stream `tool_call` 事件同步加 optional `signature`),承載 Gemini part 層級 `thoughtSignature`(Gemini 3 function calling 回放缺 signature 會 400)。streaming 時 text part signature 不保留(僅 tool_call 與 thinking 的 signature 流出)。
- prompt caching 用通用 `cache?: boolean | { ttl?: "5m"|"1h"; key?: string }` 選項(與 `reasoning`/`webSearch` 同模式:通用旗標、adapter 吸收差異),**預設關**。Anthropic 是唯一需 client 標記者,adapter 放 system+末訊息兩個 `cache_control` breakpoint(`ttl` 控 5m/1h);OpenAI/xAI `key`→`prompt_cache_key`(提高命中率);Gemini/Groq/Modal 全自動、no-op。usage 側六家早已統一(`input.details.cache_read`,Anthropic 另有 `cache_write`),不汙染 schema。`providerOptions` 仍是手動覆寫逃生口。讀取折扣與寫入溢價**逐 provider/逐模型不同**(見 [providers.md](./providers.md)),計價屬呼叫方職責,cardan 只如實回報 usage。
  - **範式邊界(刻意)**:`cache` 只涵蓋**無狀態前綴快取**——client 每次重送完整 prompt、server 比對前綴,client 不持有快取狀態(六家都屬此類,含 Gemini 隱式)。Gemini 另有**顯式具名快取**(`caches.create()` → 建一個 `CachedContent` 資源、用 name 引用、自管 TTL/刪除、按**小時 storage** 計費 over TTL),那是 stateful 管理面功能、非 per-request hint,**不塞進 `cache`**(否則逼 adapter 做資源 lifecycle,違反 lean 與「管理面 out-of-scope」)。需要時 caller 自建並走 `providerOptions: { cachedContent: "cachedContents/…" }`;cardan 不管其 lifecycle、也不計其 storage(per-token 模型表達不了時間積分成本)。日後若有「巨大固定 context 多次重用」的真實需求,再另開 `caches.*` 管理面,而非重載此選項。
- `GenerateResult`/stream `finish` 加 `rateLimit?: RateLimitStatus`(訂閱限額快照),`Provider` 介面加 optional `readonly rateLimit`(最後已知,覆蓋寫入非累加;pool 另有 `rateLimits()`)。來源是回應 header,**純觀測**,與 usage 記帳(`result.usage`,token 花費)分屬兩件事。lowest common denominator,無 header 即 `undefined`;細節見 [providers.md#anthropic](./providers.md#anthropic)。
