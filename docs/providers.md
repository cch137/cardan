# 供應商 wire 決策

各供應商與通用 schema 的映射細節。通用 schema、能力表機制見 [design.md](./design.md);跨家功能(web search、streaming/background)另見專文。

## Anthropic

thinking / effort:

- adaptive 模型(`fable`/`mythos`/`sonnet-5`/`opus-4-[89]`):`thinking: { type: "adaptive" }` + 可選 `output_config.effort`(原樣透傳 low…max)。
- 舊線(haiku-4-5 等):`thinking: { type: "enabled", budget_tokens }` 由 effort 映射(low 2k … max 32k),不送 effort 參數。
- `enabled: false`:**Sonnet 5** 預設 adaptive,必須送 `thinking: { type: "disabled" }`;**Fable/Mythos** 拒收 disabled(always-on),省略 thinking;Opus 4.8 adaptive 為 opt-in,省略即可;budget 路徑送 `disabled`。

prompt caching(唯一需 client 標記的 provider):

- **`cache` 旗標**:cardan 通用 `cache` 選項在 Anthropic 放兩個 `cache_control` breakpoint——**最後一個 system block**(快取 tools+system)與**最後一則訊息的最後一個 content block**(對話增量快取),共 2 個遠低於 4 上限。開快取時 system 強制改 block 陣列形式(API key 模式亦然)以掛 `cache_control`;OAuth 模式 breakpoint 落在 identity 之後的 systemText block。`cache: { ttl: "1h" }`→`{ type: "ephemeral", ttl: "1h" }`(寫入 2× 基礎 input 價、存活 1h),預設 5m(寫入 1.25×);讀取一律 0.1×。低於模型最小可快取長度(Opus 4.8 = 1024 tokens、Haiku 4.5 = 4096)會被靜默忽略、不報錯。`cache` 未設則行為與改動前**逐 byte 相同**(system 維持字串、無 `cache_control`)。
- **usage**:`input_tokens`(不含快取)+ `cache_read_input_tokens` + `cache_creation_input_tokens` 三者相加為 `input.total`;後兩者另記 `input.details.cache_read`/`cache_write`。**唯一**有 cache write 成本的 provider。

訂閱限額訊號(`resetAt`):

- **`oauth` 捷徑**:`AnthropicProviderOptions.oauth` 接受裸 token 字串作為 `{ credentials: { accessToken } }` 捷徑(常見於 `claude setup-token`),完整物件形式保留給需要 refresh token / `onRefresh` 的情況。讓多帳號池 `tokens.map((t) => new AnthropicProvider({ oauth: t }))` 乾淨。
- **訊號來源(已驗證)**:Messages API 回應 header `anthropic-ratelimit-unified-reset`(窗口 reset,**epoch 秒**),出現在每筆回應(含 429),且**不需 `user:profile` scope**——inference-only 的 `claude setup-token` 也可讀(實測 200 確認;另有 `unified-{5h,7d}-{utilization,reset,status}`、`unified-status`、`unified-representative-claim`)。Claude Code 對訂閱限額也讀這組 header,非 `retry-after`。
- **映射(cooldown)**:`httpError` 在 **429** 時把 `anthropic-ratelimit-unified-reset`(秒→ms)寫入 `CardanError.resetAt`;[pool](./pool.md) 以此設精確、不封頂的**帳號級**cooldown。API key 路徑無此 header → 不設 `resetAt`,退回 `retryAfterMs`(API key 429 一定帶 `Retry-After`)。
- **訂閱 429 不重試**:有 `resetAt` 的 rate_limit(訂閱窗口耗盡)標 `retryable: false`——窗口重置前重試同一帳號無效,且長 `Retry-After` 會把請求掛住;交由 pool failover 或上層立刻報錯。API key 429(無 `resetAt`)仍可重試。
- **映射(observability,`rateLimit`)**:`parseRateLimit` 在**每筆成功回應**解析整組 unified header → `RateLimitStatus`(`representative` + 代表 `status`/`resetAt` + `fiveHour`/`sevenDay` 各自 `{ utilization, resetAt, status }`;reset 秒→ms)。掛 `GenerateResult.rateLimit` 與 stream `finish`,並覆蓋寫入 `AnthropicProvider.rateLimit` 作最後已知快照(非累加,`pool` 另有 `rateLimits()`)。`status` 原樣透傳,不解讀門檻,對政策變動中性。**純觀測**,pool 不據此避讓(見 [pool.md](./pool.md));無 header → `undefined`。
- **`CardanError.resetAt`**:通用欄位(絕對 epoch ms,「限額重置的絕對時間」),語意跨 provider,任何有 reset header 的 provider 都可填;消費端照值採用,不像相對 `retryAfterMs` 封頂。
- **未採用 `/api/oauth/usage`**:該端點(`Utilization` JSON、per-model 週限額)需 `user:profile` scope,對 setup-token 403(實測)。header 路徑已足夠(精確 reset、每筆回應即時、零額外請求、setup-token 可用),故不採用、不提供 `getUsage`;額度觀測一律走上面的 `rateLimit` 快照。

## Google Gemini

- `functionCall` 在 2.x 無 id:adapter 以 `cardan_call_` 前綴合成 id 滿足配對,回放時剝除合成 id(真實 id 原樣保留)。`functionResponse` 需 `name`,adapter 從對話 tool_call 反查。
- 檔案輸入(v1):支援 inline bytes(`inlineData`)與 `URL`→`fileData.fileUri` 透傳(File API URI、YouTube URL 由呼叫方自備;cardan 不封裝 File API 上傳)。
- tools 與 structured output 用 `parametersJsonSchema`/`responseJsonSchema`(完整 JSON Schema,zod 4 輸出可直接用),不用 OpenAPI 子集的 `parameters`/`responseSchema`。
- thinking 分代:`gemini-3*` 用 `thinkingLevel`(effort low/medium/high→同名,xhigh/max→high;`enabled:false`→minimal,無法完全關閉),`gemini-2.x` 用 `thinkingBudget`(low 1024 / medium 8192 / high+ 24576;`enabled:false`→0)。
- `functionResponse.response` 必須是 JSON object:object 原樣透傳,其他值包成 `{ result: value }`,`isError` 包成 `{ error: string }`。
- prompt caching:**cardan 只用隱式快取**(2.5+ 全自動,讀取 0.1×,**無 storage、無 write fee**),`cache` 選項 no-op,`usageMetadata.cachedContentTokenCount`→`cache_read`(已含在 `input.total`,且隱式不回報任何 creation token,故 cache_write 恆 0)。**顯式** context cache(`caches.create()`/CachedContent)另有**時間維度 storage 費**($/1M tokens/小時 × TTL,如 2.5 Pro $4.50、Flash $1.00)——與 Anthropic 的 per-token write 倍率結構不同;cardan 不建立顯式快取故不可達,per-token 計費模型也無法表達時間積分成本(若未來採用需另立 storage 維度)。

## OpenAI

- 走 Responses API 且**預設 stateless**:每請求帶 `store: false` + `include: ["reasoning.encrypted_content"]`,多輪上下文由 `messages` 重放(`providerOptions` 可覆寫)。
- Responses API 無 stop sequence 參數:忽略 `stopSequences`。
- tools 一律送 `strict: false`(strict 模式要求子集 schema,會弄壞任意 schema);structured output(`text.format`)送 `strict: true`,schema 符合子集是呼叫方責任。
- reasoning 按模型映射:`gpt-5.6*` 完整 scale(含獨立 `max`);`*codex*` 上限 `xhigh`(`max`→`xhigh`);o-series 上限 `high`(`xhigh`/`max`→`high`);舊 gpt-5.x `max`→`xhigh`。`enabled: false`→`effort: "none"`(僅 gpt-5.1+;o-series/Codex 省略 `reasoning`)。啟用帶 `summary: "auto"` 取得可見 thinking。
- `function_call_output` 無 error 旗標:`isError` 的 tool_result 包成 `{"error": …}` JSON 字串。
- prompt caching 全自動(無寫入成本、≥1024 tokens 自動生效),cardan `cache` 選項僅把 `cache.key`→`prompt_cache_key`(穩定 key 提高命中率,例如 conversation id);`ttl` 忽略。讀取折扣**逐模型不同**(gpt-5.x 0.1×、o3 0.25×、gpt-4o/o1 0.5×),`input_tokens_details.cached_tokens`→`cache_read`(已含在 `input.total`)。

## xAI

- 走 Responses API(Chat Completions 已 legacy),與 OpenAI Responses 線上相容(`store: false` + `include`、`text.format`、function calling、相同 SSE):`XAIProvider` 繼承 `OpenAIProvider`,差異收斂在 protected hooks(baseUrl、`XAI_API_KEY`、採樣參數、reasoning 映射)。
- reasoning effort 在 grok-4.5+ 接受 `low`/`medium`/`high`(`xhigh`/`max` 封頂 `high`;`none` 拒收故省略欄位無法關閉);pre-4.5/fast SKU 省略 `reasoning`。不送 `summary`——xAI 對 reasoning 模型一律回 detailed summary。grok 模型(含 reasoning)保留 `temperature`/`top_p`。
- 無 embeddings:`embed` 報 `invalid_request`。
- prompt caching 全自動;Responses API 同樣吃 `prompt_cache_key`,故 `cache.key` 經繼承的 OpenAI `buildRequestBody` 直接生效(免額外 header)。讀取折扣逐模型不同(grok-4.5 約 0.25×),`input_tokens_details.cached_tokens`→`cache_read`。

### Grok Build 訂閱(OAuth / `XAIOAuthProvider`)

用 **SuperGrok 訂閱額度**(而非按量計費 API)跑推論,對應 Anthropic 的訂閱 OAuth 路徑。`grok login` 會把 token 寫進 `~/.grok/auth.json`(逆向自 x.ai CLI,詳見 `assets/gb-dist/extracted/auth-notes.md`)。**已對 live proxy 端到端驗證。**

- **端點與格式**:訂閱走 `cli-chat-proxy.grok.com/v1/**chat/completions**`(OpenAI **Chat Completions** 舊格式),與 `XAIProvider` 走的 `api.x.ai` **Responses** 不同格式。故 `XAIOAuthProvider` **繼承 `GroqProvider`(Chat Completions 機制)** 而非 `XAIProvider`;只用 fetch wrapper 換掉 auth/baseUrl/headers,零改動既有 provider。傳標準 xAI model id(如 `grok-4.5`,伺服端解析成 `grok-4.5-build`);proxy 亦收 CLI 自用的 `grok-build`。
- **必要 header(5 個)**:`Authorization: Bearer <token>`、`X-XAI-Token-Auth: xai-grok-cli`(要 proxy 把 bearer 當 CLI session 驗證)、`x-grok-model-override: <model>`(proxy 靠此 header 選模型,非 body `model`)、`x-grok-client-version`(缺/過舊回 **426**)、`Content-Type`。實測 4 header 會 426,靠 binary 補上第 5 個才 200。
- **版本門檻**:proxy 有最低版本 floor,落後 stable 約 2 個月且移動慢(floor `0.1.202` 於 2026-05-07 發布;預設送的 `0.2.93` 於 2026-07-08)。預設值有 2 個月以上餘裕,配合每月更新一次即可;真 426 時錯誤訊息會提示調 `clientVersion`。
- **auth 解析**:`~/.grok/auth.json` 結構 `{ "<scope>": { "key": <accessToken>, "refresh_token", "expires_at"(ISO) } }`;`GROK_AUTH_SCOPE` 常數即該 scope key。provider 本身 **fetch-only**——token 由呼叫端傳入 `credentials`。長跑服務用 `loadLocalOAuth` / `localOAuthPool` 讀檔並掛 `onRefresh` 寫回(見 README Local OAuth)。
- **refresh**:標準 OAuth2 `refresh_token` grant(**form-encoded**,`client_id=grok-cli`,`accounts.x.ai` token endpoint),到期前(`expiresAt`)主動換、401 再換一次;共用單一 round-trip;`onRefresh` 回寫。bare token(無 refresh_token)視為 inference-only,到期於 401 清楚報錯。
- **reasoning**:proxy 預設就串流推理內容,欄位是 `reasoning_content`(xAI Chat Completions 風格,非 Groq 的 `reasoning`;message 與 delta 皆同,實測 live 驗證),`GroqProvider` 解析兩個欄位皆讀。無需任何 request 欄位開啟;usage 記 `completion_tokens_details.reasoning_tokens`。
- **錯誤傳遞**:proxy 錯誤回 `{"error":"字串"}`,但 Chat Completions 錯誤路徑只讀 `error.message`(物件)。fetch wrapper 的 `normalizeErrorBody` 把字串型 `error` 正規化成 `{error:{message}}`(非 JSON body 原文透出),確保底層訊息(如 426)到應用層。
- **env / precedence**:env `GROK_BUILD_OAUTH_TOKEN`(對應 `CLAUDE_CODE_OAUTH_TOKEN`);工廠 `resolveXAI()` 優先序 config `xaiOAuth` > config `xai.apiKey` > env `GROK_BUILD_OAUTH_TOKEN` > env `XAI_API_KEY`,雙 env 皆設時 OAuth 勝出並 `warnOnce`。
- **ToS**:`X-XAI-Token-Auth: xai-grok-cli` 是明確宣稱「我是官方 CLI」,在 CLI 外用訂閱額度很可能違反 xAI 條款;真 CLI 另送 telemetry/session signal,裸 replay 屬異常流量。風險自負。

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
- prompt caching:vLLM/SGLang 自動 prefix cache,`cache` 選項 no-op;Modal 按**算力**計費(無 token 價),`prompt_tokens_details.cached_tokens`→`cache_read`(已含在 `input.total`),轉售計價由上層自定。
