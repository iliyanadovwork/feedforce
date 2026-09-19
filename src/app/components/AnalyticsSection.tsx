'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { Alert, BrandLoader, Button, Card, SegmentedControl, Spinner, HEADER_H } from '@/app/components/ui';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/app/components/ui/chart';
import { AccountPicker, type PickerAccount } from './SocialAccountPicker';
import { authedFetch } from '@/lib/authedFetch';

// Analytics dashboard — Zernio's Instagram analytics rendered as shadcn/Recharts line + bar charts.

interface DimVal { dimension: string; value: number }
interface SeriesPt { date: string; value: number }
interface MetricBlock { total?: number; values?: SeriesPt[]; breakdowns?: DimVal[] }
interface InsightsResp { metrics?: Record<string, MetricBlock> }
interface DemographicsResp { demographics?: { age?: DimVal[]; gender?: DimVal[]; city?: DimVal[]; country?: DimVal[] } }
interface BestTimeResp { slots?: { day_of_week: number; hour: number; avg_engagement: number; post_count: number }[] }
interface PostAnalytics { impressions?: number; reach?: number; likes?: number; comments?: number; shares?: number; saves?: number; clicks?: number; views?: number; engagementRate?: number }
interface TopPost { _id: string; content?: string; publishedAt?: string; thumbnailUrl?: string; mediaItems?: { url?: string; thumbnail?: string }[]; analytics?: PostAnalytics }
interface Pagination { page: number; limit: number; total: number; pages: number }
interface FreqRow { platform: string; posts_per_week: number; avg_engagement_rate: number; avg_engagement: number; weeks_count: number }
interface DecayBucket { bucket_order: number; bucket_label: string; avg_pct_of_final: number; post_count: number }
interface PlatformTotals { platform?: string; postCount?: number; impressions?: number; reach?: number; likes?: number; comments?: number; shares?: number; saves?: number; clicks?: number; views?: number }
interface DailyRow { date: string; postCount?: number; platformMetrics?: { instagram?: PlatformTotals }; metrics?: PlatformTotals }
type MetricKey = 'likes' | 'comments' | 'shares' | 'saves' | 'views' | 'impressions' | 'reach' | 'clicks';
interface AnalyticsResp {
  insights: InsightsResp | null;
  reach: InsightsResp | null;
  followers: InsightsResp | null;
  demographics: DemographicsResp | null;
  bestTime: BestTimeResp | null;
  frequency: { frequency?: FreqRow[] } | null;
  decay: { buckets?: DecayBucket[] } | null;
  dailyMetrics: { platformBreakdown?: PlatformTotals[]; dailyData?: DailyRow[] } | null;
  summary: { overview?: { publishedPosts?: number; totalPosts?: number }; posts?: TopPost[] } | null;
  range: { since: string; until: string; days: number };
}

const DAYS = [{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }] as const;
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ACCENT = 'var(--accent)';

// Compact axis number: M for millions, K for thousands, ≤1 decimal (trailing .0 stripped).
const trim1 = (x: number) => { const s = x.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s; };
const fmtNum = (n: number | null | undefined) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${trim1(n / 1e6)}M`;
  if (a >= 1e3) return `${trim1(n / 1e3)}K`;
  return `${n}`;
};
const fmtFull = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());
const shortDate = (d: string) => { const dt = new Date(d); return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

// ISO country code → full name (e.g. "US" → "United States") via the platform Intl data.
let regionNames: Intl.DisplayNames | null = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }
const countryName = (code: string) => { try { return regionNames?.of(code) ?? code; } catch { return code; } };

// "New York, New York" → "New York, NY". Abbreviate the region (US state, else first letters).
const US_STATES: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI',
  Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH',
  'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
  Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
  Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
};
const regionAbbrev = (region: string) => {
  const r = region.trim();
  if (US_STATES[r]) return US_STATES[r];
  return r.length <= 3 ? r.toUpperCase() : r.slice(0, 2).toUpperCase();
};
const cityLabel = (dim: string) => {
  const [city, region] = dim.split(',').map((s) => s.trim());
  return region ? `${city}, ${regionAbbrev(region)}` : city;
};

// Session cache: analytics for a (account, days) pair barely changes within minutes, but toggling
// 7→30→7 used to refetch identical data every time. Module-level so it also survives section switches;
// stale-while-revalidate — cached data renders instantly, the fetch refreshes it in the background.
const ANALYTICS_TTL_MS = 5 * 60_000;
const analyticsCache = new Map<string, { data: AnalyticsResp; at: number }>();

export function AnalyticsSection() {
  const [accounts, setAccounts] = useState<PickerAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [data, setData] = useState<AnalyticsResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch('/api/schedule/accounts');
        const json = await res.json();
        if (cancelled) return;
        const igs: PickerAccount[] = (json.accounts ?? []).filter((a: { platform: string }) => a.platform === 'instagram');
        setAccounts(igs);
        if (igs.length) setAccountId((p) => p || igs[0]._id);
      } catch { if (!cancelled) setAccounts([]); }
    })();
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    const key = `${accountId}:${days}`;
    const cached = analyticsCache.get(key);
    const fresh = !!cached && Date.now() - cached.at < ANALYTICS_TTL_MS;
    if (cached) { setData(cached.data); setError(null); }   // instant paint from cache
    if (fresh) return;                                       // within TTL — no refetch needed
    setLoading(!cached); setError(null);                     // only show the spinner on a cold load
    try {
      const res = await authedFetch(`/api/schedule/analytics?accountId=${encodeURIComponent(accountId)}&days=${days}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Couldn’t load analytics — please try again.');
      analyticsCache.set(key, { data: json, at: Date.now() });
      setData(json);
    } catch (e) {
      // Keep showing stale cached data if we had it; only surface the error on a cold load.
      if (!cached) { setError(e instanceof Error ? e.message : 'Couldn’t load analytics — please try again.'); setData(null); }
    } finally { setLoading(false); }
  }, [accountId, days]);

  useEffect(() => { if (accountId) void load(); }, [accountId, days, load]);

  // ── Derived data ────────────────────────────────────────────────────────────
  const m = data?.insights?.metrics ?? {};
  const reachSeries = data?.reach?.metrics?.reach?.values ?? [];
  const dailyData = data?.dailyMetrics?.dailyData ?? [];
  const demo = data?.demographics?.demographics ?? {};
  const age = demo.age ?? [];
  const gender = demo.gender ?? [];
  const country = (demo.country ?? []).slice(0, 6);
  const city = (demo.city ?? []).slice(0, 6);
  const slots = data?.bestTime?.slots ?? [];
  const frequency = (data?.frequency?.frequency ?? []).slice().sort((a, b) => a.posts_per_week - b.posts_per_week);
  const decay = (data?.decay?.buckets ?? []).slice().sort((a, b) => a.bucket_order - b.bucket_order);

  // Period totals from daily-metrics' platform breakdown (Instagram).
  const ig = (data?.dailyMetrics?.platformBreakdown ?? []).find((p) => p.platform === 'instagram') ?? data?.dailyMetrics?.platformBreakdown?.[0];
  const totalFollowers = data?.followers?.metrics?.follower_count?.total ?? null;
  const totalReach = ig?.reach ?? m.reach?.total ?? null;
  const totalViews = ig?.views ?? m.views?.total ?? null;
  const postCount = ig?.postCount ?? data?.summary?.overview?.publishedPosts ?? null;
  const engagementSum = ig ? (ig.likes ?? 0) + (ig.comments ?? 0) + (ig.shares ?? 0) + (ig.saves ?? 0) : null;
  // Account engagement rate = (likes+comments+shares+saves) / reach — matches Zernio's dashboard.
  const engagementRate = ig?.reach ? ((engagementSum ?? 0) / ig.reach) * 100 : null;
  const bestA = data?.summary?.posts?.[0]?.analytics;
  const bestPostEng = bestA ? (bestA.likes ?? 0) + (bestA.comments ?? 0) + (bestA.shares ?? 0) + (bestA.saves ?? 0) : null;

  const hasAnything = reachSeries.length || dailyData.length || age.length || country.length || slots.length || totalFollowers != null || totalReach != null;

  // ── States ──────────────────────────────────────────────────────────────────
  if (accounts === null) return <div className="grid h-full min-h-[60vh] place-items-center"><BrandLoader /></div>;
  if (accounts.length === 0) {
    return (
      <div className="grid h-full min-h-[60vh] place-items-center px-6 text-center">
        <p className="text-body text-fg-3">Connect an Instagram account on the <span className="text-fg-2">Post</span> page to see analytics.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-page/90 px-6 border-b border-line backdrop-blur" style={{ height: HEADER_H }}>
        <div className="flex items-center gap-3">
          <h1 className="text-title text-fg">Analytics</h1>
          {loading && <Spinner size="sm" />}
        </div>
        <div className="flex items-center gap-3">
          <div className="w-[220px]"><AccountPicker accounts={accounts} value={accountId} onChange={setAccountId} label="" /></div>
          <SegmentedControl<'7' | '30' | '90'> ariaLabel="Date range" emphasis="fill" items={DAYS.map((d) => ({ value: d.value, label: d.label }))} value={days} onChange={setDays} />
        </div>
      </header>

      <div className="px-6 py-5 flex flex-col gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {!loading && data && !hasAnything && (
          <Alert tone="info">No analytics yet — Instagram insights need a Business/Creator account with recent activity (and 100+ followers for demographics). Data can lag up to 48 hours.</Alert>
        )}

        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label="Engagement rate" value={engagementRate != null ? `${trim1(engagementRate)}%` : '—'} loading={loading} />
          <Kpi label="Total reach" value={fmtFull(totalReach)} loading={loading} />
          <Kpi label="Total followers" value={fmtFull(totalFollowers)} loading={loading} />
          <Kpi label="Views" value={fmtFull(totalViews)} loading={loading} />
          <Kpi label="Posts this period" value={fmtFull(postCount)} loading={loading} />
          <Kpi label="Best post" value={bestPostEng != null ? fmtFull(bestPostEng) : '—'} loading={loading} />
        </div>

        {/* Line charts */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Reach" subtitle={`Last ${data?.range.days ?? days} days`} loading={loading}>
            {reachSeries.length ? <SeriesLine data={reachSeries} label="Reach" /> : <Empty />}
          </ChartCard>
          <ChartCard title="Engagement over time" subtitle={`Per week · last ${data?.range.days ?? days} days`} loading={loading}>
            {dailyData.length ? <EngagementChart daily={dailyData} totals={ig} /> : <Empty hint="Not enough history yet" />}
          </ChartCard>
        </div>

        {/* Best-time heatmap + audience age */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card surface={1} padding="md">
            {loading ? <div className="grid h-[220px] place-items-center"><Spinner size="sm" /></div> : <BestTimeHeatmap slots={slots} />}
          </Card>
          <ChartCard title="Audience age" subtitle="Followers by age band" loading={loading}>
            {age.length ? <DimBar data={age} label="Followers" white /> : <Empty hint="Needs 100+ followers" />}
          </ChartCard>
        </div>

        {/* Geography + gender — three across */}
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartCard title="Top countries" subtitle="Followers by country" loading={loading}>
            {country.length ? <DimBar data={country} label="Followers" vertical yWidth={44} tooltipLabel={countryName} /> : <Empty hint="Needs 100+ followers" />}
          </ChartCard>
          <ChartCard title="Top cities" subtitle="Followers by city" loading={loading}>
            {city.length ? <DimBar data={city.map((c) => ({ dimension: cityLabel(c.dimension), value: c.value }))} label="Followers" vertical yWidth={88} /> : <Empty hint="Needs 100+ followers" />}
          </ChartCard>
          <ChartCard title="Gender" subtitle="Follower split" loading={loading}>
            {gender.length > 0 ? <GenderPie data={gender.map((g) => ({ dimension: g.dimension === 'M' ? 'Male' : g.dimension === 'F' ? 'Female' : g.dimension === 'U' ? 'Unknown' : g.dimension, value: g.value }))} /> : <Empty hint="Needs 100+ followers" />}
          </ChartCard>
        </div>

        {/* Posting frequency · posts over time · engagement accumulation */}
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartCard title="Posting frequency vs engagement" subtitle="Optimal cadence" loading={loading}>
            {frequency.length ? <FrequencyChart data={frequency} /> : <Empty hint="Not enough history yet" />}
          </ChartCard>
          <ChartCard title="Posts over time" subtitle={`Per day · last ${data?.range.days ?? days} days`} loading={loading}>
            {dailyData.length ? <PostsBarChart daily={dailyData} /> : <Empty hint="Not enough history yet" />}
          </ChartCard>
          <ChartCard title="Engagement accumulation" subtitle="How fast posts peak" loading={loading}>
            {decay.length ? <DecayChart data={decay} /> : <Empty hint="Not enough history yet" />}
          </ChartCard>
        </div>

        {/* Top performing posts */}
        <Card surface={1} padding="md">
          <span className="text-label text-fg">Top performing posts</span>
          <div className="mt-3">
            <TopPostsTable accountId={accountId} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────────
function Kpi({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <Card surface={1} padding="md">
      <div className="flex flex-col gap-2.5">
        <span className="text-caption text-fg-3">{label}</span>
        {loading
          ? <span className="flex h-[26px] items-center"><Spinner size="sm" /></span>
          : <span className="text-[26px] font-semibold leading-none text-fg tabular-nums">{value}</span>}
      </div>
    </Card>
  );
}

function ChartCard({ title, subtitle, children, loading }: { title: string; subtitle?: string; children: React.ReactNode; loading?: boolean }) {
  return (
    <Card surface={1} padding="md">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label text-fg">{title}</span>
        {subtitle && <span className="text-caption text-fg-3">{subtitle}</span>}
      </div>
      <div className="mt-3 h-[220px]">
        {loading ? <div className="grid h-full place-items-center"><Spinner size="sm" /></div> : children}
      </div>
    </Card>
  );
}

function Empty({ hint }: { hint?: string }) {
  return <div className="grid h-full place-items-center text-caption text-fg-3">{hint ?? 'No data'}</div>;
}

function SeriesLine({ data, label }: { data: SeriesPt[]; label: string }) {
  const config: ChartConfig = { value: { label, color: ACCENT } };
  return (
    <ChartContainer config={config} className="h-full">
      <LineChart data={data} margin={{ left: 4, right: 8, top: 6, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDate} />
        <YAxis tickLine={false} axisLine={false} width={36} tickFormatter={(v) => fmtNum(Number(v))} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} />} />
        <Line dataKey="value" name="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
      </LineChart>
    </ChartContainer>
  );
}

// ── Engagement over time — multi-line, toggleable (like Zernio) ──────────────────────────────────
const ENG_METRICS: { key: MetricKey; label: string; color: string }[] = [
  { key: 'likes', label: 'Likes', color: '#3b82f6' },
  { key: 'comments', label: 'Comments', color: '#8b5cf6' },
  { key: 'shares', label: 'Shares', color: '#ec4899' },
  { key: 'saves', label: 'Saves', color: '#f59e0b' },
  { key: 'views', label: 'Views', color: '#10b981' },
  { key: 'impressions', label: 'Impress.', color: '#06b6d4' },
  { key: 'reach', label: 'Reach', color: 'var(--accent)' },
  { key: 'clicks', label: 'Clicks', color: '#a1a1aa' },
];
function weekStart(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function EngagementChart({ daily, totals }: { daily: DailyRow[]; totals?: PlatformTotals }) {
  // Start with the two big metrics visible; the rest toggle on from the legend.
  const [hidden, setHidden] = useState<Set<MetricKey>>(() => new Set(ENG_METRICS.map((x) => x.key).filter((k) => k !== 'reach' && k !== 'likes')));
  const toggle = (k: MetricKey) => setHidden((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // Aggregate the daily rows into weeks (sum each metric).
  const byWeek = new Map<string, Record<MetricKey, number>>();
  for (const row of daily) {
    const mm = row.platformMetrics?.instagram ?? row.metrics ?? {};
    const wk = weekStart(row.date);
    const cur = byWeek.get(wk) ?? { likes: 0, comments: 0, shares: 0, saves: 0, views: 0, impressions: 0, reach: 0, clicks: 0 };
    for (const mt of ENG_METRICS) cur[mt.key] += (mm[mt.key] as number | undefined) ?? 0;
    byWeek.set(wk, cur);
  }
  const weeks = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([wk, v]) => ({ label: shortDate(wk), ...v }));
  const config: ChartConfig = Object.fromEntries(ENG_METRICS.map((mt) => [mt.key, { label: mt.label, color: mt.color }]));
  const er = totals?.impressions ? (((totals.likes ?? 0) + (totals.comments ?? 0) + (totals.shares ?? 0) + (totals.saves ?? 0)) / totals.impressions) * 100 : null;

  return (
    <div className="flex h-full flex-col">
      <ChartContainer config={config} className="min-h-0 w-full flex-1">
        <LineChart data={weeks} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} minTickGap={20} />
          <YAxis tickLine={false} axisLine={false} width={44} tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(Number(v))} />
          <ChartTooltip content={<ChartTooltipContent valueFormatter={(v) => fmtFull(Number(v))} />} />
          {ENG_METRICS.filter((mt) => !hidden.has(mt.key)).map((mt) => (
            <Line key={mt.key} dataKey={mt.key} name={mt.key} type="monotone" stroke={mt.color} strokeWidth={2} dot={{ r: 2, fill: mt.color, strokeWidth: 0 }} activeDot={{ r: 4 }} />
          ))}
        </LineChart>
      </ChartContainer>
      {/* Legend = toggle chips with totals — compact, single row (scrolls if it overflows) */}
      <div className="mt-2 flex flex-nowrap items-center gap-x-2.5 overflow-x-auto pb-0.5 scrollbar-none">
        {ENG_METRICS.map((mt) => {
          const on = !hidden.has(mt.key);
          return (
            <button key={mt.key} type="button" onClick={() => toggle(mt.key)} className={`inline-flex shrink-0 items-center gap-1 ${on ? '' : 'opacity-40'}`}>
              <span className="size-2 rounded-[2px]" style={{ background: mt.color }} />
              <span className="text-[10px] text-fg-2">{mt.label}</span>
              <span className="text-[10px] font-medium text-fg">{fmtNum(totals?.[mt.key])}</span>
            </button>
          );
        })}
        {er != null && (
          <span className="inline-flex shrink-0 items-center gap-1">
            <span className="text-[10px] text-fg-2">Eng. rate</span>
            <span className="text-[10px] font-medium text-accent-text">{trim1(er)}%</span>
          </span>
        )}
      </div>
    </div>
  );
}

function DimBar({ data, label, vertical, yWidth = 92, tooltipLabel, white }: { data: DimVal[]; label: string; vertical?: boolean; yWidth?: number; tooltipLabel?: (dim: string) => string; white?: boolean }) {
  const config: ChartConfig = { value: { label, color: white ? 'var(--fg)' : ACCENT } };
  return (
    <ChartContainer config={config} className="h-full">
      <BarChart data={data} layout={vertical ? 'vertical' : 'horizontal'} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
        <CartesianGrid vertical={!vertical} horizontal={vertical} />
        {vertical ? (
          <>
            <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(Number(v))} />
            <YAxis type="category" dataKey="dimension" tickLine={false} axisLine={false} width={yWidth} tickMargin={4} tick={{ fontSize: 11 }} interval={0} />
          </>
        ) : (
          <>
            <XAxis dataKey="dimension" tickLine={false} axisLine={false} tickMargin={8} interval={0} tick={{ fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} width={48} tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(Number(v))} />
          </>
        )}
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel={!tooltipLabel} labelFormatter={tooltipLabel ? (v) => tooltipLabel(String(v)) : undefined} />} />
        <Bar dataKey="value" name="value"
          fill={white ? 'var(--fg)' : 'var(--accent)'}
          radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={42} />
      </BarChart>
    </ChartContainer>
  );
}

// Male → blue, Female → pink, Unknown → dark gray (by label, not order).
const GENDER_COLOR: Record<string, string> = { Male: '#3b82f6', Female: '#ec4899', Unknown: 'var(--zinc-700)' };
const genderColor = (dim: string) => GENDER_COLOR[dim] ?? 'var(--fg-3)';
function GenderPie({ data }: { data: DimVal[] }) {
  const config: ChartConfig = Object.fromEntries(data.map((d) => [d.dimension, { label: d.dimension, color: genderColor(d.dimension) }]));
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex h-full flex-col items-center">
      <ChartContainer config={config} className="min-h-0 w-full flex-1">
        <PieChart>
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
          <Pie data={data} dataKey="value" nameKey="dimension" innerRadius="55%" outerRadius="85%" strokeWidth={2} stroke="var(--surface-1)">
            {data.map((d, i) => <Cell key={i} fill={genderColor(d.dimension)} />)}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {data.map((d, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 text-caption text-fg-2">
            <span className="size-2.5 rounded-sm" style={{ background: genderColor(d.dimension) }} />
            {d.dimension} <span className="text-fg-4">{total ? `${Math.round((d.value / total) * 100)}%` : ''}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Posting frequency vs engagement ──────────────────────────────────────────────────────────────
function FrequencyChart({ data }: { data: FreqRow[] }) {
  const chart = data.map((r) => ({ label: `${r.posts_per_week}/wk`, rate: Math.round(r.avg_engagement_rate * 10) / 10 }));
  const best = data.reduce((a, b) => (b.avg_engagement_rate > a.avg_engagement_rate ? b : a), data[0]);
  const config: ChartConfig = { rate: { label: 'Engagement rate', color: ACCENT } };
  return (
    <div className="flex h-full flex-col">
      <ChartContainer config={config} className="min-h-0 w-full flex-1">
        <BarChart data={chart} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} />
          <YAxis tickLine={false} axisLine={false} width={40} tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel valueFormatter={(v) => `${v}%`} />} />
          <Bar dataKey="rate" name="rate" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={42} />
        </BarChart>
      </ChartContainer>
      {best && <p className="mt-2 text-center text-caption text-fg-3">Optimal: <span className="font-medium text-fg-2">{best.posts_per_week}/wk</span> · {trim1(best.avg_engagement_rate)}%</p>}
    </div>
  );
}

// ── Engagement accumulation (content decay → cumulative) ─────────────────────────────────────────
function DecayChart({ data }: { data: DecayBucket[] }) {
  const chart = data.map((b, i) => ({
    label: b.bucket_label,
    cum: Math.min(100, Math.round(data.slice(0, i + 1).reduce((s, x) => s + x.avg_pct_of_final, 0))),
  }));
  const cross = (t: number) => chart.find((p) => p.cum >= t)?.label;
  const config: ChartConfig = { cum: { label: 'Cumulative engagement', color: ACCENT } };
  return (
    <div className="flex h-full flex-col">
      <ChartContainer config={config} className="min-h-0 w-full flex-1">
        <LineChart data={chart} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} />
          <YAxis tickLine={false} axisLine={false} width={40} tick={{ fontSize: 11 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
          <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => v} valueFormatter={(v) => `${v}%`} />} />
          <Line dataKey="cum" name="cum" type="monotone" stroke="var(--color-cum)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ChartContainer>
      <p className="mt-2 text-center text-caption text-fg-3">
        {cross(50) && <>Half by <span className="font-medium text-fg-2">{cross(50)}</span></>}
        {cross(80) && <> · 80% by <span className="font-medium text-fg-2">{cross(80)}</span></>}
      </p>
    </div>
  );
}

// ── Posts over time — one bar per day we posted ──────────────────────────────────────────────────
function PostsBarChart({ daily }: { daily: DailyRow[] }) {
  const rows = daily
    .map((r) => ({ label: shortDate(r.date), count: r.postCount ?? r.platformMetrics?.instagram?.postCount ?? 0 }))
    .filter((r) => r.count > 0);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const config: ChartConfig = { count: { label: 'Posts', color: ACCENT } };
  return (
    <div className="flex h-full flex-col">
      <ChartContainer config={config} className="min-h-0 w-full flex-1">
        <BarChart data={rows} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={0} minTickGap={4} />
          <YAxis tickLine={false} axisLine={false} width={28} tick={{ fontSize: 11 }} allowDecimals={false} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent valueFormatter={(v) => `${v} ${Number(v) === 1 ? 'post' : 'posts'}`} />} />
          <Bar dataKey="count" name="count" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={42} />
        </BarChart>
      </ChartContainer>
      <p className="mt-2 text-center text-caption text-fg-3"><span className="font-medium text-fg-2">{fmtFull(total)}</span> posts total</p>
    </div>
  );
}

// ── Top performing posts table (paginated, with the post thumbnail) ──────────────────────────────
const cell = (v: number | undefined | null) => (v == null ? '—' : fmtNum(v));
const postThumb = (p: TopPost) => p.thumbnailUrl || p.mediaItems?.[0]?.thumbnail || p.mediaItems?.[0]?.url;
function TopPostsTable({ accountId }: { accountId: string }) {
  const [page, setPage] = useState(1);
  const [posts, setPosts] = useState<TopPost[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [accountId]);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await authedFetch(`/api/schedule/analytics/posts?accountId=${encodeURIComponent(accountId)}&page=${page}&limit=10`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setErr(json.error ?? 'Couldn’t load posts — please try again.'); setPosts([]); }
        else { setErr(null); setPosts(json.posts ?? []); setPagination(json.pagination ?? null); }
      } catch { if (!cancelled) { setErr('Couldn’t load posts — please try again.'); setPosts([]); } }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [accountId, page]);

  if (posts === null) return <div className="grid h-24 place-items-center"><BrandLoader size={36} /></div>;
  if (err) return <Alert tone="danger">{err}</Alert>;
  if (posts.length === 0) return <div className="grid h-24 place-items-center text-caption text-fg-3">No published posts with analytics yet</div>;

  const cols: { key: keyof PostAnalytics; label: string }[] = [
    { key: 'likes', label: 'Likes' }, { key: 'comments', label: 'Comments' }, { key: 'shares', label: 'Shares' },
    { key: 'saves', label: 'Saves' }, { key: 'clicks', label: 'Clicks' }, { key: 'views', label: 'Views' },
    { key: 'impressions', label: 'Impr.' }, { key: 'reach', label: 'Reach' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-50' : ''}`}>
        <table className="w-full text-caption">
          <thead>
            <tr className="text-fg-4">
              <th className="pb-2 pr-3 text-left font-medium">Post</th>
              {cols.map((c) => <th key={c.key} className="px-2 pb-2 text-right font-medium">{c.label}</th>)}
              <th className="pb-2 pl-2 text-right font-medium">ER</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => {
              const a = p.analytics ?? {};
              const src = postThumb(p);
              return (
                <tr key={p._id} className="border-t border-line">
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2.5">
                      <div className="size-9 shrink-0 overflow-hidden rounded border border-line bg-surface-2">
                        {src && <img src={src} alt="" loading="lazy" className="size-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />}
                      </div>
                      <div className="min-w-0 max-w-[240px]">
                        <div className="truncate text-fg">{p.content || 'Untitled'}</div>
                        <div className="text-fg-4">{p.publishedAt ? new Date(p.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</div>
                      </div>
                    </div>
                  </td>
                  {cols.map((c) => <td key={c.key} className="px-2 text-right tabular-nums text-fg">{cell(a[c.key])}</td>)}
                  <td className="pl-2 text-right tabular-nums font-medium text-accent-text">{a.engagementRate != null ? `${trim1(a.engagementRate)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pagination && pagination.pages > 1 && (
        <div className="flex items-center justify-between text-caption text-fg-3">
          <span>Page {pagination.page} of {pagination.pages} · {pagination.total.toLocaleString()} posts</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
            <Button size="sm" variant="secondary" disabled={page >= pagination.pages || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Best-time heatmap (7 days × 24 hours, UTC) ───────────────────────────────────────────────────
interface Slot { day_of_week: number; hour: number; avg_engagement: number; post_count: number }
const fmtHour = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
const EMPTY_CELL = 'rgb(255 255 255 / 0.045)'; // very dark — just a hair above the card bg
function cellBg(eng: number | undefined, max: number): string {
  if (!eng || max <= 0) return EMPTY_CELL;
  const r = eng / max;
  const a = r <= 0.2 ? 0.18 : r <= 0.4 ? 0.34 : r <= 0.6 ? 0.5 : r <= 0.8 ? 0.68 : 0.9;
  return `rgb(0 205 64 / ${a})`;
}
function BestTimeHeatmap({ slots }: { slots: Slot[] }) {
  const grid: (number | undefined)[][] = Array.from({ length: 7 }, () => Array(24).fill(undefined));
  let max = 0;
  for (const s of slots) {
    if (s.day_of_week >= 0 && s.day_of_week < 7 && s.hour >= 0 && s.hour < 24) {
      grid[s.day_of_week][s.hour] = s.avg_engagement;
      if (s.avg_engagement > max) max = s.avg_engagement;
    }
  }
  const top = slots.slice().sort((a, b) => b.avg_engagement - a.avg_engagement).slice(0, 3);

  return (
    <div className="flex h-full flex-col">
      {/* Header + legend */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-label text-fg">Best time to post <span className="font-normal text-fg-4">· UTC</span></span>
        <div className="flex items-center gap-1.5" title="Colour intensity = average engagement per post">
          <span className="text-[11px] text-fg-3">Less</span>
          <div className="flex items-center gap-[2px]">
            <span className="size-2.5 rounded-sm" style={{ background: EMPTY_CELL }} />
            {[0.18, 0.34, 0.5, 0.68, 0.9].map((a) => <span key={a} className="size-2.5 rounded-sm" style={{ background: `rgb(0 205 64 / ${a})` }} />)}
          </div>
          <span className="text-[11px] text-fg-3">More</span>
        </div>
      </div>

      {slots.length === 0 ? (
        <Empty hint="Publish a few posts to see your best times" />
      ) : (
        <>
          <div className="flex flex-1 gap-1">
            {/* Day labels */}
            <div className="flex w-8 shrink-0 flex-col gap-[2px]">
              {DOW.map((d) => <div key={d} className="flex flex-1 items-center justify-end pr-1"><span className="text-[11px] leading-none text-fg-3">{d}</span></div>)}
            </div>
            {/* Grid */}
            <div className="flex min-h-[200px] min-w-0 flex-1 flex-col gap-[2px]">
              {grid.map((row, day) => (
                <div key={day} className="grid flex-1 gap-[2px]" style={{ gridTemplateColumns: 'repeat(24, 1fr)' }}>
                  {row.map((eng, h) => (
                    <div key={h} title={`${DOW[day]} ${fmtHour(h)} · ${eng != null ? `${Math.round(eng).toLocaleString()} avg engagement` : 'no data'}`}
                      className="h-full cursor-pointer rounded-sm transition-opacity hover:opacity-80" style={{ background: cellBg(eng, max) }} />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {/* Hour labels (every 3h) */}
          <div className="mt-1 flex gap-1">
            <div className="w-8 shrink-0" />
            <div className="grid flex-1" style={{ gridTemplateColumns: 'repeat(24, 1fr)' }}>
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="flex justify-center">{h % 3 === 0 && <span className="text-[11px] leading-none text-fg-3">{fmtHour(h)}</span>}</div>)}
            </div>
          </div>
          {/* Best-time chips */}
          {top.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-caption text-fg-3">Best times:</span>
              {top.map((s, i) => (
                <span key={i} title={`Avg engagement ${Math.round(s.avg_engagement).toLocaleString()} across ${s.post_count} posts`}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium bg-accent-tint text-accent-text">
                  <span>{DOW[s.day_of_week]} {fmtHour(s.hour)}</span>
                  <span className="font-normal text-accent-text">· {fmtNum(s.avg_engagement)}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
