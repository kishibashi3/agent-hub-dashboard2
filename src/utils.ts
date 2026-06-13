// ── Helpers ────────────────────────────────────────────────────
export function esc(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export function escAttr(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function fmtRelative(tsStr: string | null): string {
  if (!tsStr) return '—';
  try {
    const ts = new Date(tsStr).getTime();
    const now = Date.now();
    const s = Math.floor((now - ts) / 1000);
    if (s < 60) return '今';
    if (s < 3600) return `${Math.floor(s/60)}分前`;
    if (s < 86400) return `${Math.floor(s/3600)}時間前`;
    return `${Math.floor(s/86400)}日前`;
  } catch { return '—'; }
}

// 12 → "12", 4811 → "4.8k", 143264 → "143k", 10278914 → "10.3M"
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + 'k';
  }
  const m = n / 1_000_000;
  return (m < 10 ? m.toFixed(1) : Math.round(m).toString()) + 'M';
}

export function computePresence(lastActiveAt: string | null): 'active'|'warm'|'cold'|'absent' {
  if (!lastActiveAt) return 'absent';
  const ageMin = (Date.now() - new Date(lastActiveAt).getTime()) / 60000;
  if (ageMin <= 2) return 'active';
  if (ageMin <= 10) return 'warm';
  if (ageMin <= 60) return 'cold';
  return 'absent';
}
