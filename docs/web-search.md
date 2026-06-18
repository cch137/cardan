# Web search(內置 / server-side 工具)

- **統一入口是 first-class 欄位 `webSearch?: boolean | WebSearchOptions`,不走通用 `tools`**:web search 是 server-side 工具(供應商自己跑搜尋、回傳含引用成品),不像一般 `Tool` round-trip 回呼叫方,語意完全不同。`WebSearchOptions` 是跨供應商最小正規化集合(`maxUses`、`allowedDomains`、`blockedDomains`、`userLocation`、`contextSize`);各 adapter 只映射自己支援的、忽略其餘,獨有旗標走 `providerOptions`。
- **輸出統一為來源清單**:`GenerateResult.citations?: WebCitation[]`(`{url, title?, snippet?}`),streaming 在 `finish` 事件帶 `citations`,`collectStream` 一併收斂。這是五家都能穩定抽取的最小公因數;inline span 映射(OpenAI 字元 index、Gemini segment、Anthropic block citation)差異太大,只保留來源清單,細節留 `raw`。`addCitations` 以 URL 去重,先到者佔位、後到者補滿缺漏 title/snippet。
- **不支援即報錯**:無 web search 能力的模型請求 `webSearch` 報 `invalid_request`(各 adapter 以能力表/regex 閘控);逃生口透過 `providerOptions` 覆寫 body。
- **各 adapter 路由**:
  - Anthropic — `tools` 注入 `web_search_20250305` server tool(GA,跨 Claude 4 家族與 fable/mythos 相容);從 `web_search_tool_result` block 與 text block 的 `citations` 抽來源;`server_tool_use`/`web_search_tool_result` block 不進通用 content(留 `raw`)。
  - OpenAI — Responses `tools` 注入 `{type:"web_search"}`(filters/`search_context_size`/`user_location`);從 message 的 `url_citation` annotations 抽來源。建構工具、能力判斷、引用抽取拆成 protected hook 供 xAI 覆寫。
  - xAI — 繼承 OpenAI 但覆寫 hook:`web_search` 工具的 domain 過濾放 `filters`(allowed/excluded 互斥、各上限 5),無 `search_context_size`/`user_location`;引用除 annotations 外另讀頂層 `response.citations`。(舊 Live Search `search_parameters` 已於 2026-01-12 退役,唯一路徑是 Responses 工具。)
  - Gemini — `tools` 追加 `google_search`(Gemini 2.0+)或 `google_search_retrieval`(舊機型);從 `candidate.groundingMetadata.groundingChunks[].web` 抽 uri/title。google_search 無 domain/location 旋鈕,對應欄位忽略。
  - Groq — 能力表分流:reasoning 模型(gpt-oss)宣告內置 `browser_search`(與 structured output 不相容,衝突報 `invalid_request`);compound 系統自動跑搜尋、不宣告工具(`webSearch:true` 等同 no-op)。引用 best-effort 從 `executed_tools[].search_results.results`/message 層 `search_results` 抽;gpt-oss 內文 `【n†…】` 標記無結構化 URL,留 `raw`。
  - Modal — 自部署端點無內置 web search,`webSearch` 報 `invalid_request`。
- **工具迴圈**:OpenAI、Gemini、xAI、Groq 的搜尋迴圈都在 server 端跑完、單一回應回傳成品,呼叫端不需處理。Anthropic server tool 取樣迴圈達上限時以 `stop_reason: "pause_turn"` 中止——adapter 在 `generate` 與 `stream` 都做**透明、有上限(`MAX_SERVER_TOOL_TURNS`)的續跑**:把上一輪 assistant 回合(generate 用 raw blocks、stream 由 SSE 重建)原樣回送恢復,合併 content/citations、跨輪累加 usage(各請求分別計費),對呼叫端呈現為單一回合。
- **Usage**:Anthropic `server_tool_use.web_search_requests` 映射到 `usage.output.details.web_search_requests`(**計費的請求次數,非 token**)。
