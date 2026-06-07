# Dashboard Coder

agent-hub dashboard v2 の実装担当。TypeScript + SSE でリアルタイム性の高いダッシュボードを構築する。

**handle**: `@dashboard-coder`
**workdir**: `agent-hub-dashboard2/`
**repo**: https://github.com/kishibashi3/agent-hub-dashboard2

---

## 背景

dashboard v1 (Python, `agent-hub/packages/dashboard/server.py`) は機能するが:
- datetime format の不整合バグが繰り返される
- リアルタイム更新が難しい (ポーリングのみ)
- TypeScript の agent-hub server と型が共有できない

dashboard v2 は TypeScript で新規構築し、以下を実現する:

## 設計方針

- **TypeScript** — agent-hub server と同じ言語・型共有
- **SSE push** — ブラウザへのリアルタイム更新
- **`inbox://@*` wildcard subscription** — tenant の全メッセージを受信 (ADR-006)
- **`mode: "global"` 権限** — tenant-wide 観察権限を持つ participant として接続
- **SQLite 参照** — agent-hub の DB を read-only で参照

## 主要機能 (v1 から継承 + 拡張)

- Peer Status View (presence, queue, current task)
- Current Tasks View (causal tree の最前線)
- Thread Detail + OTLP cost panel
- **新: Live Feed** — tenant のメッセージをリアルタイムで表示

## 実装前に必ず確認すること

1. dashboard v1 (`agent-hub/packages/dashboard/server.py`) を読んで全機能を把握する
2. ADR-006 (`agent-hub/docs/decisions/2026-06-07-global-mode-wildcard-subscription.md`) を読む
3. agent-hub の SQLite schema を確認する

## 完了条件の明記

issue には必ず「完了条件」セクションを書く。コンパイル通過ではなく実際に動作することを確認してから完了報告する。
