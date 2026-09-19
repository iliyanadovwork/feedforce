// Human-readable description of what a cross-tab reel adoption actually CHANGED, for the sync toast.
// A description edit has no resting UI (it only renders inside the Description panel of the selected
// reel), so the generic "Reels updated in another tab." fired with zero visible pixels changing and read
// as a broken sync (E2E-verified 2026-07-19: adoption landed in ~150ms, the change was just invisible).
// Naming the reel and field turns the toast into evidence the sync DID work.

interface SyncableReelFields {
  id: string;
  caption?: string;
  description?: string;
  url?: string;
}

const FIELD_LABELS: Array<{ key: 'caption' | 'description' | 'url'; label: string }> = [
  { key: 'caption', label: 'caption' },
  { key: 'description', label: 'description' },
  { key: 'url', label: 'video link' },
];

export function describeReelSyncChange(
  prev: SyncableReelFields[],
  next: SyncableReelFields[],
  names: Record<string, string> = {},
): string {
  const prevById = new Map(prev.map(e => [e.id, e]));
  const nextIds = new Set(next.map(e => e.id));
  const added = next.filter(e => !prevById.has(e.id)).length;
  const removed = prev.filter(e => !nextIds.has(e.id)).length;

  const changed: Array<{ index: number; id: string; fields: string[] }> = [];
  next.forEach((e, i) => {
    const p = prevById.get(e.id);
    if (!p) return;
    const fields = FIELD_LABELS.filter(({ key }) => (p[key] ?? '') !== (e[key] ?? '')).map(({ label }) => label);
    if (fields.length) changed.push({ index: i, id: e.id, fields });
  });

  if (added && removed) return 'Reels added and removed in another tab.';
  if (added) return added === 1 ? 'A reel was added in another tab.' : `${added} reels were added in another tab.`;
  if (removed) return removed === 1 ? 'A reel was removed in another tab.' : `${removed} reels were removed in another tab.`;
  if (changed.length === 1) {
    const c = changed[0];
    const name = names[c.id];
    const who = name ? `Reel ${c.index + 1} (${name})` : `Reel ${c.index + 1}`;
    return `${who}: ${c.fields.join(' + ')} updated in another tab.`;
  }
  if (changed.length > 1) return `${changed.length} reels updated in another tab.`;
  // Nothing detectable in the text fields (e.g. a framing/template-only change): keep the generic notice.
  return 'Reels updated in another tab.';
}
