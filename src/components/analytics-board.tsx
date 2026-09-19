import type { ReactNode } from "react";

import {
	ACCENT,
	DemoBadge,
	DemoWindow,
	SectionIntro,
	Spark,
} from "@/components/demo-ui";
import { Reveal } from "@/components/reveal";

// Analytics board — KPIs + charts + an AI analysis panel.

function StatCard({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl border border-white/10 p-3">
			<div className="text-[11px] font-medium text-zinc-500">{label}</div>
			<div className="mt-1.5 text-[1.25rem]/[1.75rem] font-bold leading-none tracking-tight text-zinc-100">
				{value}
			</div>
		</div>
	);
}

// Catmull-Rom → cubic bezier, so a series of points renders as one smooth curve.
function smoothLine(points: [number, number][]) {
	if (points.length < 2) return "";
	const d = [`M ${points[0][0]},${points[0][1]}`];
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i === 0 ? 0 : i - 1];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[i + 2] ?? p2;
		const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
		const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
		const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
		const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
		d.push(`C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`);
	}
	return d.join(" ");
}

function ReachChart() {
	// Two periods as layered green curves that cross naturally (this period
	// brighter on top, last period a darker green behind), fading to the baseline.
	const darkGreen = "#033512";
	const frontGreen = "#00b439";
	const front: [number, number][] = [
		[0, 22], [8, 18], [16, 26], [25, 21], [33, 30], [42, 19], [50, 24],
		[59, 12], [67, 17], [75, 23], [84, 11], [92, 16], [100, 9],
	];
	const back: [number, number][] = [
		[0, 8], [8, 18], [16, 28], [25, 31], [33, 34], [42, 29], [50, 31],
		[59, 23], [67, 25], [75, 17], [84, 19], [92, 11], [100, 13],
	];
	const frontLine = smoothLine(front);
	const backLine = smoothLine(back);
	const area = `${frontLine} L 100,40 L 0,40 Z`;
	const backArea = `${backLine} L 100,40 L 0,40 Z`;
	return (
		<div className="flex h-full flex-col rounded-xl border border-white/10 p-4">
			<div className="mb-3 flex items-center justify-between">
				<span className="text-[0.75rem]/[1rem] font-semibold text-zinc-100">Reach</span>
				<span className="text-[11px] text-zinc-500">Last 30 days</span>
			</div>
			<div className="flex min-h-0 flex-1 gap-2">
				<div className="relative min-h-[120px] flex-1">
					<svg
						viewBox="0 0 100 40"
						preserveAspectRatio="none"
						className="h-full w-full overflow-visible"
					>
						<defs>
							<linearGradient id="anFade" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={frontGreen} stopOpacity="0.3" />
								<stop offset="100%" stopColor={frontGreen} stopOpacity="0" />
							</linearGradient>
							<linearGradient id="anFadeBack" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={darkGreen} stopOpacity="0.32" />
								<stop offset="100%" stopColor={darkGreen} stopOpacity="0" />
							</linearGradient>
						</defs>
						{[8, 18, 28, 38].map((y) => (
							<line
								key={y}
								x1="0"
								y1={y}
								x2="100"
								y2={y}
								stroke="rgba(255,255,255,0.06)"
								strokeWidth="0.5"
								vectorEffect="non-scaling-stroke"
							/>
						))}
						<path d={backArea} fill="url(#anFadeBack)" />
						<path
							d={backLine}
							fill="none"
							stroke={darkGreen}
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							vectorEffect="non-scaling-stroke"
						/>
						<path d={area} fill="url(#anFade)" />
						<path
							d={frontLine}
							fill="none"
							stroke={frontGreen}
							strokeWidth="1.75"
							strokeLinecap="round"
							strokeLinejoin="round"
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
				</div>
			</div>
			<div className="mt-2 flex justify-between text-[9px] text-zinc-600">
				<span>Wk 1</span>
				<span>Wk 2</span>
				<span>Wk 3</span>
				<span>Wk 4</span>
			</div>
		</div>
	);
}

function EngagementBars() {
	const bars = [
		{ l: "Mon", h: 48 },
		{ l: "Tue", h: 64 },
		{ l: "Wed", h: 52 },
		{ l: "Thu", h: 80 },
		{ l: "Fri", h: 58 },
		{ l: "Sat", h: 96 },
		{ l: "Sun", h: 72 },
	];
	const peak = bars.reduce((m, b, i, a) => (b.h > a[m].h ? i : m), 0);
	return (
		<div className="flex h-full flex-col rounded-xl border border-white/10 p-4">
			<div className="mb-3 flex items-center justify-between">
				<span className="text-[0.75rem]/[1rem] font-semibold text-zinc-100">
					Engagement by day
				</span>
				<span className="text-[11px] text-zinc-500">This week</span>
			</div>
			<div className="flex min-h-[120px] flex-1 items-end gap-2">
				{bars.map((b, i) => (
					<div
						key={b.l}
						className="flex-1 rounded-t"
						style={{
							height: `${b.h}%`,
							background: i === peak ? "#ffffff" : "rgb(255 255 255 / 0.22)",
						}}
					/>
				))}
			</div>
			<div className="mt-1.5 flex gap-2">
				{bars.map((b) => (
					<span key={b.l} className="flex-1 text-center text-[9px] text-zinc-600">
						{b.l}
					</span>
				))}
			</div>
		</div>
	);
}

const INSIGHTS: { tag: string; body: ReactNode }[] = [
	{
		tag: "Format",
		body: (
			<>
				Carousels drove{" "}
				<span className="font-semibold text-zinc-100">38% more saves</span> than
				reels this week.
			</>
		),
	},
	{
		tag: "Timing",
		body: (
			<>
				Posts at 6pm reach{" "}
				<span className="font-semibold text-zinc-100">2.1× more accounts</span>{" "}
				than mornings.
			</>
		),
	},
	{
		tag: "Hooks",
		body: (
			<>
				Questions in the hook earn{" "}
				<span className="font-semibold text-zinc-100">24% more comments</span>.
			</>
		),
	},
];

function AnalyticsBoard() {
	return (
		<DemoWindow
			title="FeedForce · Analytics"
			badge={<DemoBadge dot>Connected</DemoBadge>}
			label="AI ANALYTICS"
			number="05"
		>
			<div className="grid lg:grid-cols-[1fr_300px]">
				{/* KPIs + charts */}
				<div className="flex flex-col gap-4 p-5">
					<div className="flex items-center justify-between">
						<span className="text-[0.875rem]/[1.25rem] font-bold tracking-tight text-zinc-100">
							Overview
						</span>
						<div className="flex rounded-md border border-white/10 bg-white/[0.02] p-0.5 text-[10px] font-semibold">
							{["7D", "30D", "90D"].map((r, i) => (
								<span
									key={r}
									className={`rounded px-2 py-0.5 ${i === 1 ? "bg-zinc-100 text-zinc-900" : "text-zinc-500"}`}
								>
									{r}
								</span>
							))}
						</div>
					</div>
					<div className="grid grid-cols-3 gap-3">
						<StatCard label="Reach" value="48.2K" />
						<StatCard label="Engagement" value="6.4%" />
						<StatCard label="Followers" value="+1,204" />
					</div>
					<div className="grid flex-1 gap-3 sm:grid-cols-2 sm:grid-rows-1">
						<ReachChart />
						<EngagementBars />
					</div>
				</div>

				{/* AI analysis panel */}
				<div className="flex flex-col border-t border-white/10 bg-white/[0.02] p-4 lg:border-l lg:border-t-0">
					<div className="flex items-center gap-2">
						<span className="shrink-0 translate-y-px">
							<Spark color={ACCENT} />
						</span>
						<span className="text-[13px] font-semibold text-zinc-100">
							AI analysis
						</span>
						<span className="ml-auto">
							<DemoBadge dot>Live</DemoBadge>
						</span>
					</div>
					<p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
						What worked this week
					</p>
					<div className="mt-2 flex flex-col gap-2">
						{INSIGHTS.map((it) => (
							<div
								key={it.tag}
								className="rounded-lg border border-white/10 bg-white/[0.04] p-3"
							>
								<span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
									{it.tag}
								</span>
								<p className="mt-1 text-[0.75rem]/[1rem] leading-relaxed text-zinc-400">
									{it.body}
								</p>
							</div>
						))}
					</div>
					<div className="mt-auto flex flex-col gap-2 pt-4">
						<span className="grid w-full place-items-center rounded-lg bg-zinc-100 px-3 py-2 text-[0.75rem]/[1rem] font-semibold text-zinc-900">
							Generate full report
						</span>
						<span className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-500">
							<Spark color={ACCENT} /> Available as a node in your flow
						</span>
					</div>
				</div>
			</div>
		</DemoWindow>
	);
}

export function AnalyticsBoardSection() {
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<SectionIntro
						eyebrow="Analytics"
						title="Understand precisely what performed, and why"
					>
						FeedForce connects to your channels and distills every post into a
						clear performance summary. The AI interprets your results,
						identifies what performed, and feeds those insights back into your
						nodes.
					</SectionIntro>
				</Reveal>

				<Reveal delay={120}>
					<div className="mt-12">
						<AnalyticsBoard />
					</div>
				</Reveal>
			</div>
		</section>
	);
}
