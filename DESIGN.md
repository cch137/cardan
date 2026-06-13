# cardan — Design

統一各大 LLM 供應商 API 的 TypeScript adapter 庫。發佈到 npm,供 Deno(`npm:cardan`)與 Node 專案使用。

## 動機

- raven 內部已有一層自寫的 provider 抽象(`lib/utils/ai/`),但它綁死在 raven repo,獨立專案(kairos、ticks)無法使用。
- 不信任 aggregator 類套件的供應鏈:**不依賴 `ai`(Vercel AI SDK)、`litellm`、`langchain` 及其生態**。這類套件依賴樹龐大、更新頻繁、由第三方統一封裝所有供應商,單點被攻破影響面太大。
- 自有 schema 讓 usage 記帳、訊息儲存、跨供應商切換不受任何上游套件的 breaking change 牽制。

## 設計原則

1. **根據官方文檔直接構建 adapter**,以原生 `fetch` 發 HTTP 請求為預設手段;只有在某 API 用 HTTP 實作明顯不切實際時,才考慮引入該供應商的第一方 SDK,並且逐案評估。
2. **零執行期依賴**(zero runtime dependencies)。這是供應鏈安全的最強保證,也是這個庫存在的核心理由之一。唯一例外是 zod,以 optional peerDependency 形式支援(見技術決策)——不用 zod 的消費者依然零依賴。
3. **自有通用 schema**:message、tool、usage 等核心型別由 cardan 定義,各 adapter 負責與供應商格式雙向轉換。
4. **簡單、高效**:不做用不到的抽象;每個供應商一個檔案/目錄,新增供應商不需要動核心。
5. **考慮未來擴展**:schema 設計預留欄位擴充空間(例如新的 content 類型、新的 usage 細項),但不預先實作。

## Goals

- 統一的 `generate`(含 streaming)介面,涵蓋:多輪訊息、system prompt、tool calling、structured output(JSON Schema)、reasoning/thinking、vision 輸入。
- 統一的 usage schema:input/output token 總量 + 細項(cache read/write、reasoning tokens 等),足以支撐成本記帳。
- 統一的錯誤分類(auth、rate limit、overloaded、context length、invalid request、network),可重試錯誤自動退避重試,尊重 `Retry-After`。
- 統一的 streaming 事件流(AsyncIterable),事件種類最小化。
- Embeddings(僅限有提供的供應商)。
- 跑在 Node ≥ 20 與 Deno;不依賴任何 Node 專屬 API(只用 `fetch`/`AbortSignal` 等 Web 標準),天然支援 edge runtime。

## Non-goals

- **不做 agent framework**:無 loop、無 memory、無 planning。
- **不做 prompt 管理**:無模板、無 prompt registry。
- **不做 RAG**:無 vector store、無 chunking。
- **不做 gateway/proxy**:cardan 是 client 端的庫,不是服務。
- **不做供應商自動 fallback/路由**(v1):呼叫方自行決定用哪個 model;路由是上層應用的職責。
- **不追求覆蓋所有供應商**:只支援下方分級清單,新增供應商需有實際使用需求。
- **不重新發明 SDK 的全部功能**:files API、batch API、fine-tuning 等管理面功能不在範圍內,除非未來有實際需求再逐案加入。

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

分級含義:第一梯隊的功能缺口視為 bug;第二梯隊保證基本 generate/streaming/tools 可用;第三梯隊盡力而為,壞了再修。

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

- assistant 回合的 tool calls 與其結果(`tool_result`)在 schema 層配對,由各 adapter 負責映射到供應商各自的格式(Anthropic 的 content blocks、OpenAI Responses 的 items、Gemini 的 parts)。
- 供應商獨有能力(如 Anthropic 的 prompt caching 控制、OpenAI 的 reasoning effort)透過 per-provider 的 options 欄位透傳,不汙染通用 schema。
- **模型差異由 adapter 內建的 per-model 能力表(capability table)吸收**,不是呼叫方的必填知識。通用 schema 允許 system 訊息出現在任何位置;無法表達的供應商/模型由 adapter 自動降轉(例如 Anthropic 的 system 是 top-level 參數而非 message role,adapter 負責 hoist;不支援對話中段 system 的模型,降轉為併入相鄰 user 訊息)。options 是覆寫這些預設策略的逃生口。
- **訊息序列正規化**:部分供應商強制 user/assistant 嚴格交錯、或要求 tool_result 緊跟對應的 tool_call。adapter 在送出前自動正規化:合併連續同 role 的訊息、將 tool_result 重排到對應 call 之後;懸空的 tool_call(有 call 無 result)需有明確策略(補上錯誤 result 或直接報錯,實作時定案並文檔化)。
- **tool call ID 保真**:供應商指定的 call id(OpenAI 的 `call_…`、Anthropic 的 `toolu_…`)在通用 schema 中原樣保存,回送同一供應商時原樣使用,絕不重新生成。跨供應商重放對話時由 adapter 重映射 id,但 call/result 的配對關係必須維持。
- 錯誤統一為帶 `code` 的 error class,保留原始 response 供除錯。

## 技術決策

- **ESM only**,TypeScript 編譯產出 `dist/`(tsdown),`exports` 單一入口;供應商 adapter 是否拆 subpath exports(`cardan/anthropic`)待 API 成形後決定。
- **認證**:API key 由呼叫方顯式傳入,也支援讀取各供應商慣例的環境變數;cardan 不做任何 key 的儲存或管理。
- **重試**:預設對 429/5xx/網路錯誤做有上限的指數退避,可關閉;timeout 與取消用 `AbortSignal`。
- **模型識別與路由**:統一入口用 `provider/model` 字串(如 `openai/gpt-5.5`),由入口解析後直接路由到對應 adapter。解析規則定死為**只切第一個 `/`**:前段是 provider,其餘原樣傳給供應商(模型名本身可能含 `/`,如 `groq/meta-llama/llama-4-scout`)。per-provider adapter 直接收不帶前綴的模型名。不 hard-code 封閉的模型集合(維護成本高、落後上游);型別層用 template literal + `(string & {})` 提供已知模型的 autocomplete。
- **zod 支援**:zod 是 optional peerDependency(`zod@^4`)。tools 與 structured output 的 schema 參數接受純 JSON Schema 物件或 zod schema;zod schema 用其實例方法 `.parse()` 驗證回應、用 zod 4 原生 `z.toJSONSchema` 轉換(動態 import,僅在呼叫方實際傳入 zod schema 時觸發)。cardan 內部解析供應商回應不用 zod,維持 TypeScript 型別 + 防禦性解析。
- **測試**:核心轉換邏輯(message/usage/stream 的雙向映射、訊息序列正規化)用 fixture 單元測試;對真實 API 的 smoke test 獨立成手動執行的腳本,不進 CI。

## 開放問題

- [ ] raven 的 `lib/utils/ai/` 與 ticks 的 Vercel AI SDK 用法何時遷移到 cardan;遷移前 cardan 的 API 視為不穩定(0.x)。

## 已決議

- runtime 驗證:供應商回應不引入 schema 庫,TypeScript 型別 + 防禦性解析;zod 僅作為呼叫方的 schema 輸入格式支援(optional peerDependency)。
- 懸空 tool_call:補上錯誤 result(`isError: true`,內容 "tool call produced no result"),讓中斷的對話可重放;孤兒/重複 tool_result 則直接報 `invalid_request`。
- StreamEvent 在最小集合外加了 `thinking_signature`(thinking block 關閉時帶出重放簽章),否則 streaming 產生的 thinking 無法在多輪 tool use 中回送。
- `ThinkingPart` 加 `redacted?: boolean` 表達 Anthropic `redacted_thinking`(signature 欄位存放不透明 data)。
- `TextPart`/`ToolCallPart` 加 `signature?: string`(stream 的 `tool_call` 事件同步加 optional `signature`),承載 Gemini part 層級的 `thoughtSignature`——Gemini 3 function calling 回放時缺 signature 會直接 400。streaming 時 text part 的 signature 不保留(事件種類維持最小;僅 tool_call 與 thinking 的 signature 會流出)。
- Gemini 2.x 的 `functionCall` 沒有 id:adapter 以 `cardan_call_` 前綴合成 id 滿足通用 schema 的配對要求,回放 Gemini 時剝除合成 id(真實 id 原樣保留)。`functionResponse` 需要 `name`,由 adapter 從對話中的 tool_call 反查。
- Gemini 檔案輸入:v1 支援 inline bytes(`inlineData`)與 `URL` → `fileData.fileUri` 透傳(File API URI、YouTube URL 由呼叫方自備;cardan 不封裝 File API 上傳)。
- Gemini tools 與 structured output 用 `parametersJsonSchema`/`responseJsonSchema`(完整 JSON Schema,zod 4 輸出可直接用),不用 OpenAPI 子集的 `parameters`/`responseSchema`。
- Gemini thinking 分代映射:`gemini-3*` 用 `thinkingLevel`(effort low/medium/high→同名,xhigh/max→high;`enabled:false`→minimal,Gemini 3 無法完全關閉),`gemini-2.x` 用 `thinkingBudget`(low 1024 / medium 8192 / high+ 24576;`enabled:false`→0)。
- Gemini `functionResponse.response` 必須是 JSON object:object 原樣透傳,其他值包成 `{ result: value }`,`isError` 包成 `{ error: string }`。
- OpenAI 走 Responses API 且**預設 stateless**:每個請求帶 `store: false` + `include: ["reasoning.encrypted_content"]`,多輪上下文一律由 `messages` 重放(`providerOptions` 可覆寫)。
- `ThinkingPart` 加 `id?: string`(stream 的 `thinking_signature` 事件同步加 optional `id`),承載 OpenAI reasoning item id(`rs_…`):stateless 重放 reasoning item 需要 `id` + `encrypted_content`(存進 `signature`)兩者,缺一即丟棄該 part。
- Responses API 沒有 stop sequence 參數:OpenAI adapter 忽略 `stopSequences`。
- OpenAI tools 一律送 `strict: false`(strict 模式要求 structured-output 子集 schema,會弄壞任意呼叫方 schema);structured output(`text.format`)則送 `strict: true`,schema 需符合子集是呼叫方責任。
- OpenAI reasoning 映射:effort `max`→`xhigh`(OpenAI 上限),`enabled: false`→`effort: "none"`(僅 gpt-5.1+ 支援;舊模型請直接省略 `reasoning`);啟用時帶 `summary: "auto"` 以取得可見 thinking。
- OpenAI `function_call_output` 沒有 error 旗標:`isError` 的 tool_result 包成 `{"error": …}` JSON 字串送出。
- xAI 走 Responses API(官方已將 Chat Completions 標為 legacy),與 OpenAI Responses 線上相容(同樣支援 `store: false` + `include: ["reasoning.encrypted_content"]`、`text.format`、function calling、相同 SSE 事件):`XAIProvider` 直接繼承 `OpenAIProvider`,差異收斂在 protected hooks(baseUrl、`XAI_API_KEY`、採樣參數、reasoning 映射)。
- xAI reasoning effort 只接受 `none`/`low`/`medium`/`high`(`xhigh`/`max` 封頂到 `high`;僅 grok-4.3+ 支援,舊模型請省略 `reasoning`);不送 `summary` 參數——xAI 對 reasoning 模型一律回傳 detailed summary。grok 模型(含 reasoning)保留 `temperature`/`top_p`。
- xAI 無 embeddings API:`embed` 直接報 `invalid_request`。
- Modal 走 **Chat Completions**(`/v1/chat/completions`),不是 Responses:Modal 官方 LLM serving 範式是把 vLLM/SGLang 包在 `@modal.web_server` 後面,兩者的標準端點都是 Chat Completions。`ModalProvider` 獨立實作,不繼承 `OpenAIProvider`。
- Modal `baseUrl` 必填(每個部署有獨有的 `*.modal.run` URL,無全域預設;可用 `MODAL_BASE_URL`)。認證雙軌皆選用、可並用:`apiKey`→`Authorization: Bearer`(vLLM/SGLang `--api-key`;env `MODAL_API_KEY`),`proxyAuth`→`Modal-Key`/`Modal-Secret` 標頭(Modal Proxy Auth Token;env `MODAL_KEY`/`MODAL_SECRET`,cardan 自訂慣例,依標頭命名)。proxy auth 只給一半直接報 `auth`。
- Chat Completions 無 reasoning 回放格式:replay 時 thinking parts 一律丟棄;回應的 `reasoning_content`(vLLM/SGLang 擴展,message 與 streaming delta 都有)映射為無 signature 的 ThinkingPart。通用 schema 不需為此調整。
- Modal reasoning 控制:`effort`→`reasoning_effort`(low/medium/high,xhigh/max 封頂 high;不支援的模型/伺服器會 4xx,呼叫方省略 `reasoning` 即可);`enabled` 無通用映射,忽略——模型特定開關(如 vLLM 的 `chat_template_kwargs: { enable_thinking: false }`)走 `providerOptions`。
- Modal 送 `max_tokens`(不送 `max_completion_tokens`)以最大化自部署伺服器相容性;`stopSequences`→`stop` 正常支援;structured output 走 `response_format: { type: "json_schema" }`。
- Modal streaming 帶 `stream_options: { include_usage: true }`;不支援的舊伺服器 usage 記 0。tool call 以 `index` 聚合分段 arguments,缺 id 的伺服器以 `cardan_call_` 合成補齊。
- Modal `embed` 打 `/v1/embeddings`,僅當部署的是 embedding 模型時可用。
- Groq 走 **Chat Completions**(`/openai/v1/chat/completions`,穩定主力 API),不走其 Responses API:後者標示 beta 且明確不支援 `store`/`include`(stateless OpenAI adapter 的核心機制),無法繼承 `OpenAIProvider`。`GroqProvider` 獨立實作(與 Modal 同為 Chat Completions,但 wire 細節不同,不互相繼承)。
- Groq reasoning 以 per-model 能力表吸收:reasoning 模型(gpt-oss、qwen3)一律送 `reasoning_format: "parsed"`(thinking 進 `message.reasoning`/streaming `delta.reasoning`,不混入 content;tool use 與 JSON mode 也要求 parsed/hidden);非 reasoning 模型不能送此參數(400)。`reasoning_effort` 分家:gpt-oss 收 low/medium/high(xhigh/max 封頂 high),qwen3 只收 none/default(分級 effort 一律省略);`enabled: false`→`"none"`(僅 qwen3 接受,gpt-oss 無法關閉 reasoning 會被 API 明確拒絕)。非 reasoning 模型請省略 `reasoning`。
- Groq structured output:`response_format.json_schema` 的 `strict: true`(constrained decoding)僅 gpt-oss 支援,能力表閘控;其他模型走 best-effort(不帶 strict 旗標,zod schema 仍由 client 端驗證)。不支援 json_schema 的模型(llama-3.x)由 Groq 直接報錯。
- Groq streaming usage 在 `finish_reason` chunk 上(頂層 `usage` 與 `x_groq.usage` 皆有,免 `stream_options`),終止符 `data: [DONE]`;tool call 以 `index` 聚合,id(`fc_…`)原樣保留。prompt caching 全自動,`prompt_tokens_details.cached_tokens`→`cache_read`。413(request_too_large)映射 `context_length`。
- Groq 送 `max_completion_tokens`;無 embeddings API,`embed` 直接報 `invalid_request`。
