import type { DataType } from '@/lib/automations';

// Icon key → SVG, for node descriptors (descriptors store an icon string to stay framework-free).
const PATHS: Record<string, React.ReactNode> = {
  play: <><circle cx="12" cy="12" r="9" /><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
  sparkles: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor" stroke="none" />,
  code: <><polyline points="9 8 5 12 9 16" /><polyline points="15 8 19 12 15 16" /></>,
  branch: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M8.5 6.5h4a3 3 0 0 1 3 3v.5" /></>,
  template: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />,
};

export function NodeIcon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name] ?? PATHS.code}
    </svg>
  );
}

// Port dot colour by data type (so connections read at a glance).
export function dataTypeColor(t: DataType): string {
  switch (t) {
    case 'string': return '#60a5fa';   // blue
    case 'number': return '#fbbf24';   // amber
    case 'boolean': return '#f472b6';  // pink
    case 'image': case 'video': return '#a78bfa'; // violet
    case 'series': return '#34d399';   // green
    case 'array': case 'object': return '#94a3b8'; // slate
    default: return '#71717a';         // zinc (any)
  }
}
