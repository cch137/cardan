# cardan — Design notes

cardan 的內部設計與決策紀錄(**不隨 npm 套件發佈**)。對外使用文件見 [../README.md](../README.md)。

- [design.md](./design.md) — 動機、設計原則、Goals/Non-goals、供應商分級、核心抽象、技術決策、schema 已決議
- [providers.md](./providers.md) — 各供應商 wire 決策(Anthropic / Gemini / OpenAI / xAI / Groq / Modal)
- [pool.md](./pool.md) — 多帳號 failover + cooldown(`PoolProvider`)
- [streaming.md](./streaming.md) — 長請求與斷線(streaming / background)
- [web-search.md](./web-search.md) — 內置 web search
- [conversation-agent.md](./conversation-agent.md) — Conversation 與 Agent 層、原生編排
