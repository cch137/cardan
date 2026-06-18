# 供應商 wire 決策

各供應商與通用 schema 的映射細節。通用 schema、能力表機制見 [design.md](./design.md);跨家功能(web search、streaming/background)另見專文。

## Anthropic

訂閱限額訊號(`resetAt`):

- **`oauth` 捷徑**:`AnthropicProviderOptions.oauth` 接受裸 token 字串作為 `{ credentials: { accessToken } }` 捷徑(常見於 `claude setup-token`),完整物件形式保留給需要 refresh token / `onRefresh` 的情況。讓多帳號池 `tokens.map((t) => new AnthropicProvider({ oauth: t }))` 乾淨。
- **訊號來源(已驗證)**:Messages API 回應 header `anthropic-ratelimit-unified-reset`(窗口 reset,**epoch 秒**),出現在每筆回應(含 429),且**不需 `user:profile` scope**——inference-only 的 `claude setup-token` 也可讀(實測 200 確認;另有 `unified-{5h,7d}-{utilization,reset,status}`、`unified-status`、`unified-representative-claim`)。Claude Code 對訂閱限額也讀這組 header,非 `retry-after`。
- **映射**:`httpError` 在 **429** 時把該 header(秒→ms)寫入 `CardanError.resetAt`;[pool](./pool.md) 以此設精確、不封頂的**帳號級**cooldown。API key 路徑無此 header → 不設 `resetAt`,退回 `retryAfterMs`(API key 429 一定帶 `Retry-After`)。
- **`CardanError.resetAt`**:通用欄位(絕對 epoch ms,「限額重置的絕對時間」),語意跨 provider,任何有 reset header 的 provider 都可填;消費端照值採用,不像相對 `retryAfterMs` 封頂。
- **未採用 `/api/oauth/usage`**:該端點(`Utilization` JSON、per-model 週限額)需 `user:profile` scope,對 setup-token 403。header 路徑已足夠(精確 reset、零額外請求、setup-token 可用),故不採用,也不提供 `getUsage`。

## Google Gemini

- `functionCall` 在 2.x 無 id:adapter 以 `cardan_call_` 前綴合成 id 滿足配對,回放時剝除合成 id(真實 id 原樣保留)。`functionResponse` 需 `name`,adapter 從對話 tool_call 反查。
- 檔案輸入(v1):支援 inline bytes(`inlineData`)與 `URL`→`fileData.fileUri` 透傳(File API URI、YouTube URL 由呼叫方自備;cardan 不封裝 File API 上傳)。
- tools 與 structured output 用 `parametersJsonSchema`/`responseJsonSchema`(完整 JSON Schema,zod 4 輸出可直接用),不用 OpenAPI 子集的 `parameters`/`responseSchema`。
- thinking 分代:`gemini-3*` 用 `thinkingLevel`(effort low/medium/high→同名,xhigh/max→high;`enabled:false`→minimal,無法完全關閉),`gemini-2.x` 用 `thinkingBudget`(low 1024 / medium 8192 / high+ 24576;`enabled:false`→0)。
- `functionResponse.response` 必須是 JSON object:object 原樣透傳,其他值包成 `{ result: value }`,`isError` 包成 `{ error: string }`。

## OpenAI

- 走 Responses API 且**預設 stateless**:每請求帶 `store: false` + `include: ["reasoning.encrypted_content"]`,多輪上下文由 `messages` 重放(`providerOptions` 可覆寫)。
- Responses API 無 stop sequence 參數:忽略 `stopSequences`。
- tools 一律送 `strict: false`(strict 模式要求子集 schema,會弄壞任意 schema);structured output(`text.format`)送 `strict: true`,schema 符合子集是呼叫方責任。
- reasoning:effort `max`→`xhigh`(上限),`enabled: false`→`effort: "none"`(僅 gpt-5.1+;舊模型省略 `reasoning`);啟用帶 `summary: "auto"` 取得可見 thinking。
- `function_call_output` 無 error 旗標:`isError` 的 tool_result 包成 `{"error": …}` JSON 字串。

## xAI

- 走 Responses API(Chat Completions 已 legacy),與 OpenAI Responses 線上相容(`store: false` + `include`、`text.format`、function calling、相同 SSE):`XAIProvider` 繼承 `OpenAIProvider`,差異收斂在 protected hooks(baseUrl、`XAI_API_KEY`、採樣參數、reasoning 映射)。
- reasoning effort 只接受 `none`/`low`/`medium`/`high`(`xhigh`/`max` 封頂 `high`;僅 grok-4.3+,舊模型省略 `reasoning`);不送 `summary`——xAI 對 reasoning 模型一律回 detailed summary。grok 模型(含 reasoning)保留 `temperature`/`top_p`。
- 無 embeddings:`embed` 報 `invalid_request`。

## Groq

- 走 **Chat Completions**(`/openai/v1/chat/completions`,穩定主力),不走 Responses API(後者 beta 且不支援 `store`/`include`,無法繼承 `OpenAIProvider`)。`GroqProvider` 獨立實作(與 Modal 同為 Chat Completions 但 wire 細節不同,不互相繼承)。
- reasoning 以能力表吸收:reasoning 模型(gpt-oss、qwen3)一律送 `reasoning_format: "parsed"`(thinking 進 `message.reasoning`/`delta.reasoning`,不混入 content;tool use 與 JSON mode 也要 parsed);非 reasoning 模型不能送此參數(400)。`reasoning_effort` 分家:gpt-oss 收 low/medium/high(xhigh/max 封頂 high),qwen3 只收 none/default(分級 effort 省略);`enabled: false`→`"none"`(僅 qwen3,gpt-oss 無法關閉會被拒)。非 reasoning 模型省略 `reasoning`。
- structured output:`response_format.json_schema` 的 `strict: true`(constrained decoding)僅 gpt-oss 支援,能力表閘控;其他走 best-effort(不帶 strict,zod schema 仍 client 端驗證)。不支援 json_schema 的模型(llama-3.x)由 Groq 報錯。
- streaming usage 在 `finish_reason` chunk 上(頂層 `usage` 與 `x_groq.usage` 皆有,免 `stream_options`),終止符 `data: [DONE]`;tool call 以 `index` 聚合,id(`fc_…`)原樣保留。prompt caching 全自動,`prompt_tokens_details.cached_tokens`→`cache_read`。413(request_too_large)映射 `context_length`。
- 送 `max_completion_tokens`;無 embeddings,`embed` 報 `invalid_request`。

## Modal(自部署)

- 走 **Chat Completions**(`/v1/chat/completions`),非 Responses:Modal 官方 LLM serving 是 vLLM/SGLang 包在 `@modal.web_server` 後,標準端點是 Chat Completions。`ModalProvider` 獨立實作,不繼承 `OpenAIProvider`。
- `baseUrl` 必填(每部署有獨有 `*.modal.run` URL,無全域預設;可用 `MODAL_BASE_URL`)。認證雙軌皆選用、可並用:`apiKey`→`Authorization: Bearer`(vLLM/SGLang `--api-key`;`MODAL_API_KEY`),`proxyAuth`→`Modal-Key`/`Modal-Secret` 標頭(Modal Proxy Auth Token;`MODAL_KEY`/`MODAL_SECRET`)。proxy auth 只給一半報 `auth`。
- Chat Completions 無 reasoning 回放格式:replay 時 thinking parts 一律丟棄;回應 `reasoning_content`(vLLM/SGLang 擴展,message 與 streaming delta 都有)映射為無 signature 的 ThinkingPart。
- reasoning:`effort`→`reasoning_effort`(low/medium/high,xhigh/max 封頂 high;不支援的模型/伺服器 4xx,省略 `reasoning` 即可);`enabled` 無通用映射,忽略——模型特定開關(如 vLLM `chat_template_kwargs: { enable_thinking: false }`)走 `providerOptions`。
- 送 `max_tokens`(不送 `max_completion_tokens`)以最大化自部署相容性;`stopSequences`→`stop` 正常支援;structured output 走 `response_format: { type: "json_schema" }`。
- streaming 帶 `stream_options: { include_usage: true }`;不支援的舊伺服器 usage 記 0。tool call 以 `index` 聚合分段 arguments,缺 id 以 `cardan_call_` 合成。
- `embed` 打 `/v1/embeddings`,僅部署 embedding 模型時可用。
