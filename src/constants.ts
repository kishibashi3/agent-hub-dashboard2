// ── Environment ────────────────────────────────────────────────
export const DB_PATH = process.env.AGENT_HUB_DB_PATH ?? '/app/data/app.db';
if (!process.env.AGENT_HUB_TENANT) throw new Error('AGENT_HUB_TENANT is required');
export const TENANT = process.env.AGENT_HUB_TENANT;
export const PORT = parseInt(process.env.PORT ?? '8080', 10);
export const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/$/, '');
export const STALE_HOURS = parseInt(process.env.AGENT_HUB_DASHBOARD_STALE_HOURS ?? '24', 10);

// ── Health constants ───────────────────────────────────────────
export const PPD_THREAD_THRESHOLD = parseInt(process.env.AGENT_HUB_PPD_THREAD_THRESHOLD ?? '5', 10);
export const PPD_CRITICAL_THRESHOLD = parseInt(process.env.AGENT_HUB_PPD_CRITICAL_THRESHOLD ?? '10', 10);
export const PPD_SEVERE_THRESHOLD = parseInt(process.env.AGENT_HUB_PPD_SEVERE_THRESHOLD ?? '20', 10);

export const CDS_HIGH_SIGNALS = ['着手します','実装開始','dispatch','依頼します','依頼しました','お願いします','対応します','PR を作','commit','push','完了しました','完了です','PR を出しました','LGTM','merge しました','マージしました','finished','done','完了','実装しました','調査しました','調査完了','作成しました','ブロックされています','エラーが発生','設計に問題','ブロック','失敗しました','エラー:','エラーが出','問題が発生','障害'];
export const CDS_LOW_SIGNALS = ['了解しました','了解です','ありがとうございます','確認しました','承知しました','分かりました','わかりました','受け取りました','待機中','standby','次タスクを待っています','待機します','idle','待ちます','準備完了','ready','はい','OK','ok','nod'];
export const CDS_WARNING_THRESHOLD = 50;
export const CDS_DANGER_THRESHOLD = 40;

export const META_SIGNALS = ['プロセスを変更','手順を見直し','運用を調整','フローを改善','プロセス改善','フロー変更','運用改善','手順変更','ルールを更新','規約を変更','CLAUDE.md を修正','persona を更新','CLAUDE.md を更新','CLAUDE.md に追記','規約を追加','ルール変更','ロールを変更','担当を変更','責務を見直し','役割を変更','担当変更','役割調整','bridge を再起動','respawn','bridge を stop','spawn','bridge 再起動','再起動してください','stop-bridge','start-bridge'];
export const MOR_WARNING = 30;
export const MOR_DANGER = 40;

export const ESCALATION_SIGNALS = ['確認をお願い','判断をお願い','GO をお願い','承認','許可をください','どうしますか','判断してください','エスカレーション','確認お願い','判断お願い'];
export const GO_RESPONSE_SIGNALS = ['了解','進めてください','GO','問題ありません','承認します','OK','go ','go\n','GO\n','Go '];
export const NON_GO_RESPONSE_SIGNALS = ['待ってください','変更が必要','やり直し','却下','別の方法','確認が必要','設計を見直し','NG','保留','差し戻し'];
