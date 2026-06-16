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

- 統一的 `generate`(含 streaming)介面,涵蓋:多輪訊息、system prompt、tool calling、structured output(JSON Schema)、reasoning/thinking、vision 輸入、內置 web search。
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
- **重試**:預設對 429/5xx/網路錯誤做有上限的指數退避,可關閉;取消用 `AbortSignal`。
- **逾時(timeout)**:`timeoutMs`(per-request 或各 `ProviderOptions` 預設,per-request 優先)是**每次 HTTP 嘗試**的上限(重試重置),`undefined`/`0`(預設)為**不逾時**(LLM 高 effort 請求耗時不可預測,硬塞預設易誤砍;與 OpenAI/Anthropic SDK 預設逾時不同,刻意選不逾時)。逾時以**可重試**的 `CardanError`(`code:"timeout"`)中止,與呼叫方 `signal` 取消(`code:"aborted"`,不重試)區分。語意錨定在「回應開始(headers 到達)」:非串流 `generate` 因伺服器生成完才回應,等同整體生成上限;串流只約束連線建立(中途卡住用 `signal`)。實作為各 provider `request()` 內以 `withTimeoutSignal` 合成 caller signal + timer,利用「fetch 以 `signal.reason` 拒絕」讓 timeout 錯誤原樣浮現(`finally` 清 timer)。要硬性總上限用 `signal: AbortSignal.timeout(ms)`;串流 idle-timeout 與總 deadline 不內建(v1)。
- **模型識別與路由**:統一入口用 `provider/model` 字串(如 `openai/gpt-5.5`),由入口解析後直接路由到對應 adapter。解析規則定死為**只切第一個 `/`**:前段是 provider,其餘原樣傳給供應商(模型名本身可能含 `/`,如 `groq/meta-llama/llama-4-scout`)。per-provider adapter 直接收不帶前綴的模型名。不 hard-code 封閉的模型集合(維護成本高、落後上游);型別層用 template literal + `(string & {})` 提供已知模型的 autocomplete。**autocomplete 清單只列前沿模型**:同價位若已有更好的替代品,舊型號預設淘汰、不列入(`(string & {})` 仍接受任何字串,僅是不再提示);測試同步只用前沿模型,唯獨刻意驗證「能力缺失」的負向測試保留不具該能力的舊模型作 fixture。
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

### 長請求與斷線(streaming / background)

- **問題**:高 reasoning effort(`high`/`xhigh`/`max`)的請求耗時長,單一長 HTTP 連線容易被中間層的 idle timeout 砍斷。各供應商官方文檔對此的標準建議一致:**長請求不要用單一非串流請求**。
- **主線解法(跨供應商、預設):streaming**。streaming 連線持續吐事件把 socket 保溫——高 effort 時 cardan 已帶 `summary: "auto"`(OpenAI/Responses 系)/各家 reasoning summary,thinking deltas 在思考期間就流出,不會出現長時間靜默。這是六家唯一一致的防斷線手段,且 cardan 已具備(`stream()` + `collectStream`)。**會斷線的是非串流 `generate()`**;對長/高 effort 請求,呼叫方應走 `stream()`。`generate()` 維持原狀(短請求的便利原語),不內部改走串流端點。
- **background 模式(OpenAI / xAI Responses,已實作)**:`GenerateOptions.background` 三態——`undefined`(預設)為 **auto**:reasoning effort 為 `high`/`xhigh`/`max`(長生成、最易被 idle timeout 砍)時自動開,否則關;`true`/`false` 強制開關。**background ≠ batch**:它**立刻以正常優先序執行**(只有極短排隊),純粹把「執行」與「HTTP 連線」解耦——連線斷了工作仍在 server 跑,幾乎不增加延遲,本質就是防斷線工具。
  - **`store` 連動**:background 強制 `store: true`(否則無法輪詢/取回),覆蓋 cardan「預設 `store: false`」;`include: ["reasoning.encrypted_content"]` 在 background 下照送,thinking 仍從 `messages` 重放(不靠 server state),與 stateless 路徑行為一致。呼叫方可用 `providerOptions` 覆寫。background 不相容 ZDR、資料僅留約 10 分鐘,呼叫方自行斟酌。
  - **`generate`**:POST 建立後拿 `id`,以固定間隔 GET `/v1/responses/{id}` 輪詢,離開 `queued`/`in_progress` 即解析終態。輪詢總時長由呼叫方的 `signal` 約束(無內建上限)。
  - **`stream`**:POST 開 `background: true` + `stream: true` 的 SSE;連線中途斷掉(讀取錯誤或無 `response.completed` 即收尾)時,以 GET `/v1/responses/{id}?stream=true&starting_after=<sequence_number>` **透明續流**,對呼叫端仍是單一事件流。只在連線層級的中斷(network)續接;auth/server/`abort` 不續、直接拋。續接次數有上限(防無進展死迴圈)。
  - **xAI 繼承**:xAI Responses 與 OpenAI 線上相容(同樣支援 `background`/`store`/GET 取回),`XAIProvider` 直接繼承實作,auto 規則一致(effort 在送出前才封頂到 `high`,auto 判斷用通用 effort,故 `xhigh`/`max` 仍視為高 effort 開 background)。
- **不做跨供應商 `background` 統一抽象**:只有 OpenAI 與 xAI 的 Responses 有「即時、與連線解耦」的 background,故只在這兩家實作;其餘對 `background` 一律忽略。背後機制本就發散到無法乾淨統一——xAI 另有 **Deferred Chat Completions**(`deferred: true` → `request_id` → poll `/v1/chat/deferred-completion/{id}`,未好回 202)但走 **Chat Completions 端點**(非 cardan xAI 用的 Responses),我們不採用;Anthropic/Gemini/Groq **沒有**即時 background,只有 Batch(慢、離峰),它們的防斷線只能靠 streaming。
- **Batch API 維持範圍外**(與 Non-goals 一致):Batch(Anthropic Message Batches、Gemini/Groq/xAI Batch API)是**吞吐導向**——server 離峰才處理、best-effort 約 24h SLA、半價,延遲高且不可控,目的是「不急、要便宜、要量大」。與 background「即時執行、只解耦連線」目的相反,**不能拿來防斷線**;語意與 `generate`/`stream` 完全不同。需要時由上層應用直接打供應商 Batch 端點,cardan 不封裝。

### Web search(內置/server-side 工具)

- **統一入口是 first-class 欄位 `webSearch?: boolean | WebSearchOptions`,不走通用 `tools`**:web search 是 server-side 工具(供應商自己跑搜尋、回傳含引用的成品),不像一般 `Tool` 會 round-trip 回呼叫方,語意完全不同,故獨立成欄位。`WebSearchOptions` 是跨供應商的最小正規化集合(`maxUses`、`allowedDomains`、`blockedDomains`、`userLocation`、`contextSize`);各 adapter 只映射自己支援的欄位、忽略其餘,供應商獨有旗標走 `providerOptions`。
- **輸出統一為來源清單**:`GenerateResult.citations?: WebCitation[]`(`{url, title?, snippet?}`),streaming 在 `finish` 事件帶 `citations`,`collectStream` 一併收斂。這是五家都能穩定抽取的最小公因數;inline span 映射(OpenAI 字元 index、Gemini segment、Anthropic block citation)差異太大,只保留來源清單,原始細節留在 `raw`。`addCitations` 以 URL 去重,先到者佔位、後到者補滿缺漏的 title/snippet。
- **不支援即報錯**:在沒有 web search 能力的模型上請求 `webSearch` 一律報 `invalid_request`(各 adapter 以能力表/regex 閘控);需要逃生口時透過 `providerOptions` 直接覆寫請求 body。
- **各 adapter 路由**:
  - Anthropic — `tools` 注入 `web_search_20250305` server tool(GA,跨 Claude 4 家族與 fable/mythos 相容);從 `web_search_tool_result` block 與 text block 的 `citations` 抽來源;`server_tool_use`/`web_search_tool_result` block 不進通用 content(留在 `raw`)。
  - OpenAI — Responses `tools` 注入 `{type:"web_search"}`(filters / `search_context_size` / `user_location`);從 message 的 `url_citation` annotations 抽來源。建構工具、能力判斷、引用抽取都拆成 protected hook 供 xAI 覆寫。
  - xAI — 繼承 OpenAI 但覆寫 hook:`web_search` 工具的 domain 過濾放 `filters`(allowed/excluded 互斥、各上限 5),無 `search_context_size`/`user_location`;引用除 annotations 外另讀頂層 `response.citations`。(舊的 Live Search `search_parameters` 已於 2026-01-12 退役,唯一路徑是 Responses 工具。)
  - Gemini — `tools` 追加 `google_search`(Gemini 2.0+)或 `google_search_retrieval`(舊機型);從 `candidate.groundingMetadata.groundingChunks[].web` 抽 uri/title。google_search 無 domain/location 旋鈕,`WebSearchOptions` 對應欄位忽略。
  - Groq — 能力表分流:reasoning 模型(gpt-oss)宣告內置 `browser_search` 工具(與 structured output 不相容,衝突報 `invalid_request`);compound 系統自動跑搜尋、不宣告工具(`webSearch:true` 等同 no-op)。引用 best-effort 從 `executed_tools[].search_results.results` / message 層 `search_results` 抽取;gpt-oss 的內文 `【n†…】` 標記無結構化 URL,留在 `raw`。
  - Modal — 自部署端點無內置 web search,`webSearch` 直接報 `invalid_request`。
- **工具迴圈**:OpenAI、Gemini、xAI、Groq 的搜尋迴圈都在 server 端跑完、單一回應回傳成品,呼叫端不需處理。Anthropic 的 server tool 取樣迴圈達上限時以 `stop_reason: "pause_turn"` 中止——adapter 在 `generate` 與 `stream` 都做**透明、有上限(`MAX_SERVER_TOOL_TURNS`)的續跑**:把上一輪 assistant 回合(generate 用 raw blocks、stream 由 SSE 重建 raw blocks)原樣回送以恢復,合併 content/citations、跨輪累加 usage(各請求分別計費,加總即實際帳),對呼叫端呈現為單一回合。
- **Usage**:Anthropic 的 `server_tool_use.web_search_requests` 映射到 `usage.output.details.web_search_requests`(這是**計費的請求次數,非 token**,以明確命名標示)。

### Conversation(有狀態對話層)

- **定位**:`generate` 是無狀態原語,`Conversation` 是它的有狀態對偶——持有可變 transcript,把「push user → generate → push assistant」折疊成一次 `ask`。放在主 entry,`sideEffects:false` 可 tree-shake,只要 adapter 的人不負擔 runner。不依賴任何 logger,維持零執行期依賴。
- **統一 config 包**:所有 turn-config 收在單一 `defaults: AskOptions`,`model`/`tools`/`reasoning`… 一視同仁——`model` 不特權化。`ask` 以 spread-merge(`{...defaults, ...callOptions}`)疊加,故可逐 turn 覆寫、可重指派 `defaults.model` 持久切換。預設只放生命週期跟對話一樣長的東西;phase-scoped 的(如某步才用的 tools)按 turn 傳,避免洩漏到該 tool-free 的步驟。
- **單一入口 `ask`**:無 `tools` 時單次生成;有 `tools`(`ToolHandler[]`)時自動跑 model↔tools 迴圈,`maxRounds` 封頂(預設 8)並在最後一輪強制 `toolChoice:"none"`,保證末訊息不留懸空 tool_call。**`tools` 與 `output` 不可同回合併用**:結構化輸出在各家都是 constrained decoding(`response_format`/`responseSchema`),會封死 tool call 讓迴圈空轉,故 `ask` 直接拋 `invalid_request`——正解是先跑 tool 迴圈、再以單獨一次帶 `output` 的 `ask` 收成結構化結果(README 範例即此兩步式)。
- **`compact` 是可替換的壓縮器**(`Compactor = (region: Message[]) => Message[]`),迴圈後改寫它附加的往返,避免原始工具輸出(如抓取的頁面)被後續回合重放——既省 context 也避開內容過濾。`compact:true` 用預設 `redactToolResults`:**保留 tool_call/tool_result 結構、只把 result 內容換成佔位字串**——讓模型仍看見「結論是靠工具得出的」,不會誤以為是天生知識(直接 splice 掉整段會造成這種幻覺)。要更激進可用內建 `dropToolRounds`(只留結論)或自寫(如 LLM 摘要);自訂壓縮器需維持 call/result 配對,否則靠 normalize 補懸空結果。
- **型別貫穿(零依賴)**:`ZodLikeSchema<T>` 的 `parse` 回傳型別承載輸出型別,`Infer<S>` 由此結構性還原而不 import zod。`defineTool(spec, run)` 讓 `run` 的 args 從 schema 推導(zod→具體型別、純 JSON Schema→`unknown`)。結構化輸出只是 `ask` 的 `output.schema` 選項,`res.output` 即解析後的值,要靜態型別自行 `as Infer<typeof schema>`——cardan 是通用模組,不為「輸出 JSON」另設專用方法或假定它是主要用法。
- **telemetry 解耦**:cardan 自身不 log;`onCall(info)` 每次 generate 觸發一次(成功帶 `finishReason`、失敗帶 `error`),`tag`/`model`/`ms`/`usage`/`citations` 由消費端自訂格式與路由。
- **`fork(overrides?)`**:複製 transcript(+ defaults)、共用 client,得到可獨立發散的分支對話。並行 fan-out 前必須 fork,否則多分支同時 mutate 同一個 `messages` 會損毀(superstep 對 state 唯讀,但 Conversation 可變)。

### Flow / Agent(編排層)

- **刻意不做圖**:沒有 `edges` 表、沒有 `END` 標記、沒有 node 名稱註冊表——這些都是 LangGraph 的影子。一個 **step 就是 async 函式**,靠回傳 `goto(next, patch?)` 決定下一步,控制流(分支、循環、fan-out)寫在普通程式碼裡。返回不帶 `goto`(或 void/patch)即結束該分支。借的只剩「共享型別 state + superstep 讓並行合併具決定性 + 帶上限循環」;丟掉 checkpointer、Pregel channels、interrupt/HITL、subgraph、reducer 宣告儀式、langchain 耦合。
- **三層、互不耦合**:`flow.ts`(泛型 async step 執行器,完全不認得 LLM)、`conversation.ts`(完全不認得 flow)、`agent.ts`(唯一同時認得兩者的薄膠水)。`flow.ts` 只在 `extendCtx` 開一個擴充縫——核心只 `Object.assign` 擴充物件進 ctx,不知道 `conversation` 是什麼;`withConversations(cardan)` 由膠水層供應,把 `ctx.conversation(...)` 的 `onCall` 自動轉為 `{type:"llm", name, iteration, call}` flow 事件。純 flow 使用者 `X=unknown`,零負擔。
- **執行 = BSP superstep**:維護 frontier(step 函式集合);每 superstep 對「同一份 state 快照」並行跑,蒐集 `Partial<S>` patches,在 barrier 用 reducer 合併,再從各 step 的 `goto.next` 算下個 frontier(以**函式參照**去重)。**`goto` 同一函式的分支自動 join**(跑一次)。不等長分支的真同步刻意不做——那種並行收進「step 內 `parallel()`」處理(這是讓執行器保持小的關鍵取捨)。去重/join 用**函式參照**(`Set<Step>`)而非名稱,故 minify 改名不影響收斂正確性。
- **fail-fast 且喚醒兄弟**:同 superstep 的 step 用 `Promise.all`,任一拋錯即拒絕整個 run;執行器以內部 `AbortController` 在拋錯當下 abort,讓**仍在飛的兄弟 step**經 `ctx.signal` 收到中止(它們 spawn 的 conversation / `parallel()` 才能取消),而非白跑到底。呼叫端的 `signal` 也併入這個 composed signal,故 step 只需認一個 `ctx.signal`。
- **決定性合併**:每個被寫的 key,單寫入=覆寫(或有 reducer 就 fold);**多個並行 step 寫同一 key 但沒宣告 reducer → 直接拋 `FlowError`**,把不確定性在執行期擋下而非靜默 last-write-wins。
- **路由即程式碼**:沒有 router/edge 概念。`goto(next, patch?)` 繼續、`goto([a,b], patch?)` fan-out、回傳 patch/void 停止;循環 = step `goto` 自己,條件路由 = `if` 選下一個 step。step 身分(tracing 用)取自函式名(匿名 → `"(anonymous)"`);這只影響事件標籤,minify 後會退化成短名,**不影響去重/join**(用參照)。
- **循環安全**:`maxSteps`(預設 25)封頂 superstep 數,超過拋 `FlowError`;state 為純物件,要持久化自行序列化(checkpoint/resume 不內建)。
- **`parallel(items, fn, {concurrency, signal})`**:泛型限流並行 map(零 LLM/flow 依賴),保序、fail-fast、可中止。step 內 fan-out 的主力,只有「分支有不同後續路由」時才改用 step 層 fan-out。
