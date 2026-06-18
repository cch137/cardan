# Conversation 與 Agent

`generate` 是無狀態原語;`Conversation`(有狀態對話)與 `Agent`(身份層)疊在其上。使用方式見 [../README.md](../README.md#conversation)。

## Conversation(有狀態對話層)

- **定位**:有狀態對偶——持有可變 transcript,把「push user → generate → push assistant」折疊成一次 `ask`。放主 entry,`sideEffects:false` 可 tree-shake,只用 adapter 的人不負擔 runner。不依賴 logger,維持零執行期依賴。
- **統一 config 包**:所有 turn-config 收在單一 `defaults: AskOptions`,`model`/`tools`/`reasoning`… 一視同仁——`model` 不特權化。`ask` 以 spread-merge(`{...defaults, ...callOptions}`)疊加,可逐 turn 覆寫、可重指派 `defaults.model` 持久切換。預設只放生命週期跟對話一樣長的;phase-scoped 的(如某步才用的 tools)按 turn 傳。
- **單一入口 `ask`**:無 `tools` 時單次生成;有 `tools`(`ToolHandler[]`)時自動跑 model↔tools 迴圈,`maxRounds` 封頂(預設 8)並在最後一輪強制 `toolChoice:"none"`,保證末訊息不留懸空 tool_call。**`tools` 與 `output` 不可同回合**:結構化輸出在各家都是 constrained decoding,會封死 tool call 讓迴圈空轉,故 `ask` 直接拋 `invalid_request`——先跑 tool 迴圈、再以單獨一次帶 `output` 的 `ask` 收成。
- **`compact` 是可替換壓縮器**(`Compactor = (region: Message[]) => Message[]`),迴圈後改寫它附加的往返,避免原始工具輸出(如抓取的頁面)被後續回合重放,既省 context 也避開內容過濾。`compact:true` 用預設 `redactToolResults`:保留 tool_call/tool_result 結構、只把 result 內容換成佔位字串,讓模型仍看見「結論是靠工具得出」而非天生知識(直接 splice 掉整段會造成此幻覺)。要更激進用內建 `dropToolRounds`(只留結論)或自寫;自訂壓縮器需維持 call/result 配對,否則靠 normalize 補懸空結果。
- **型別貫穿(零依賴)**:`ZodLikeSchema<T>` 的 `parse` 回傳型別承載輸出型別,`Infer<S>` 由此結構性還原而不 import zod。`defineTool(spec, run)` 讓 `run` 的 args 從 schema 推導(zod→具體型別、純 JSON Schema→`unknown`)。結構化輸出只是 `ask` 的 `output.schema` 選項,`res.output` 即解析後的值,要靜態型別自行 `as Infer<typeof schema>`。
- **telemetry 解耦**:cardan 自身不 log;`onCall(info)` 每次 generate 觸發一次(成功帶 `finishReason`、失敗帶 `error`),`tag`/`model`/`ms`/`usage`/`citations` 由消費端自訂格式與路由。
- **`fork(overrides?)`**:複製 transcript(+ defaults)、共用 client,得到可獨立發散的分支對話。並行 fan-out(如 `parallel()` 內各分支)前必須 fork,否則多分支同時 mutate 同一 `messages` 會損毀。

## Agent(身份層)

- **移除 Flow**:原 superstep/goto 執行器(`flow.ts`)已下架。LLM 編排的「狀態」活在 `Conversation`、「並行」用 `parallel()`、順序/分支/迴圈用原生 `async`/`if`/`while` 就夠;superstep 唯一獨有的「決定性合併」反而逼出不等長分支對齊的複雜度,且全 repo 無外部消費,故整層移除。
- **`Agent` = 可複用身份 + 可選 memory,層疊在 `Conversation` 上**,本身零 runtime——`run`/`conversation()` 當場建一個 `Conversation` 做事。`agent.ts` 是身份層與 conversation 間唯一的縫;`conversation.ts` 不認得 agent。
- **`run` vs `conversation()`**:`run(input)` 是封閉一次性任務(recall memory → `ask`(有 tools 自動迴圈)→ observe → 回傳);`conversation()` 回傳預配身份的 `Conversation` 讓呼叫端自驅多輪(中途/條件式引導 = `ask` 之間插 `if`)。`conversation()` 刻意不套 memory——自驅下 observe 時機未定。
- **`run` 回傳累計 usage**:`Conversation` 不跨輪累加(usage 只在 `onCall`),`ask`/tool 迴圈回傳值只是最後一輪。`run` 注入累加 `onCall`(`emptyUsage()` + 逐輪 `addUsage`,並轉發使用者 `onCall`)、以累計值覆寫回傳,讓「讀回傳值 = 整次任務成本」成正確預設;`addUsage` 提到 `types.ts` 共用。
- **memory 是身份的跨會話狀態**(transcript 是會話內的):最輕注入鉤子 `{ recall(): string; observe(result): void }`,`run` 前 recall 併入 system、後 observe。cardan 只定何時呼叫,存哪/怎麼壓縮由呼叫方;**不做 vector**。無 `memory` 的 agent 是無狀態純身份。
- **編排回歸原生**:`parallel(items, fn, {concurrency, signal})`(零 LLM 依賴、保序、fail-fast、可中止)做節點內資料並行;不同分支各取自己的 `agent`/`conversation`(或 `conversation.fork()`)避免 transcript 衝突。
- **多 agent `Discussion`(共享記錄 + 視角投影)為未來方向**,本次未做:落地前需解投影保多模態、strip 歷史 thinking、tool 迴圈抽無狀態 helper、並行發言歸併等。
