# CLI — `cardan detect`

`package.json` 的 `bin: { "cardan": "./dist/cli.js" }` 讓使用者零設定即可 `npx cardan detect`(或全域安裝後 `cardan detect`)。對外使用說明見 [../README.md](../README.md#cli);本文記錄內部設計決策。

## 分層(資料 vs 呈現)

- [`src/detect.ts`](../src/detect.ts) — **純資料**:候選檔名、shape 抽取、單/多使用者偵測,經 `DetectIO` / `UsersIO` 注入 IO,測試餵 fixtures([`test/detect.test.ts`](../test/detect.test.ts))。runtime 進入點 `detectCredentials()`(單一使用者)與 `detectAllUsers()`(全機)在同檔內以**動態** `import("node:fs"/"node:os")` 取得預設 IO — 靜態層面 library 不含 node builtins,edge runtime 退化為 env-only。連同 `hasAnyCredential` / `isExpired` 從 `index.ts` 匯出供程式內呼叫;**不含任何文字渲染**。
- [`src/cli.ts`](../src/cli.ts) — **呈現層 + 殼**:所有把偵測資料組成可讀文字/`.env` 區塊的邏輯(`renderDetections` / `renderUsers`)都在這裡,加上 argv(`detect` / `--all-users`)、exit code、`--version`/`--help`。渲染函式有匯出並單測;CLI 主體只在此檔被當進入點執行時才跑(`invokedAsCli()` 以 realpath 比對 `import.meta.url`,故 npm bin symlink 也能匹配),被 import(如測試)時無副作用。

**Windows**:`os.homedir()` 回 `%USERPROFILE%`,fs 接受 `/` 混 `\`,故單使用者路徑天然可用;多使用者掃 `%SystemDrive%\Users\*`,路徑比對正規化分隔符並忽略大小寫。

## 檔名 fallback

兩家 CLI 都改過憑證檔名(Grok:`credentials.json` → `auth.json`)。搜尋順序=「該供應商已知檔名(新→舊)」+「共用候選池」去重:

| 供應商 | 目錄 | 已知檔名 | 最終順序 |
| --- | --- | --- | --- |
| Anthropic | `~/.claude/` | `.credentials.json` | `.credentials.json` → `credentials.json` → `.auth.json` → `auth.json` |
| xAI | `~/.grok/` | `auth.json` → `credentials.json` | `auth.json` → `credentials.json` → `.credentials.json` → `.auth.json` |

共用池(`candidateFileNames` 內的本地清單)涵蓋兩家未來可能換用的名字;檔案存在但 JSON 壞掉或 shape 不符時繼續往下試,第一個成功抽取的檔案獲勝。

## Shape-based 抽取(不依賴 key 名)

- **xAI**:`~/.grok/auth.json` 頂層 key 是含 audience UUID 的 scope 字串(`https://auth.x.ai::<uuid>`),UUID 會換 — 所以掃描所有 value,凡 object 且帶非空字串 `key` 即視為憑證;多個 entry 時取 `expires_at` 最晚者(無 expiry 視為最新)。
- **Anthropic**:現行包在 `claudeAiOauth` 下,防其改名 — 接受 root 本身或任一頂層 value 為帶字串 `accessToken` 的 object。

## 不 refresh(硬規則)

detect 完全離線、純讀。兩家的 refresh token 都是旋轉式(用一次舊的即作廢),在官方 CLI 之外 refresh 而不寫回會直接弄壞使用者的 `claude` / `grok` 登入。過期只標示 `EXPIRED` 並提示跑官方 CLI 刷新。

## 多使用者(`--all-users`)

`detectAllUsers` 列舉可讀的家目錄(Linux `/home/*` + `/root`、macOS `/Users/*` + `/var/root`、Windows `%SystemDrive%\Users\*`),各自跑一次偵測。

- **權限**:`readFile` / `readDir` 皆包 try/catch 回 `undefined` — 無權限的家目錄/檔案靜默略過,不報錯、不中斷。
- **保留規則**:current 帳號永遠列出(即使空);其餘帳號僅在找到憑證時列出,避免 `Public`/`Default` 等偽帳號洗版。
- **合併 env block**:同一 env var 跨帳號有多把 token 時編號(`GROK_BUILD_OAUTH_TOKEN1`、`2`…)並註記 `# from <user>`;cardan 只讀無後綴名,故提示「挑一把、去掉編號」。單把則不編號。

## 輸出契約

偵測**只看憑證檔案,與環境變數無關** —— env 有沒有設既不會觸發也不會抑制偵測。每個供應商一節(`file` / `subscription` 或 `account` / `access token` / `refresh token`),結尾是可直接貼進 `.env` 的 block(env var 名對齊 cardan 執行時讀取的名字:`CLAUDE_CODE_OAUTH_TOKEN`、`GROK_BUILD_OAUTH_TOKEN`),過期 token 上方加 `#` 註解。找到任一憑證檔案 exit 0,否則 1。

**安全**:輸出含明文 access token,stdout 應視為機密 —— 別導進共享 log/CI,`--all-users`(尤其以 root 執行)會印出其他帳號的 token。這是刻意的產品行為(方便貼上),非疏漏。
