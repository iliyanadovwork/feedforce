import {
	ACCENT,
	AIBuilderPanel,
	BuiltList,
	DemoBadge,
	DemoWindow,
	GRID_BG_STYLE,
	SectionIntro,
} from "@/components/demo-ui";
import { Reveal } from "@/components/reveal";

// Dynamic, data-driven template demo — live data bound into a rendered post.

function MiniChart() {
	// Real AAPL daily closes (last ~30 sessions), normalised to the 120×48 viewBox.
	const pts =
		"0,25 5.9,20.6 11.8,14.4 17.7,15.1 23.6,11.1 29.5,8.4 35.4,9.1 41.3,18.4 47.2,4 53.1,12 59,10.4 64.9,16.8 70.8,26.2 76.7,44 82.6,42.3 88.5,35.8 94.4,43.1 100.3,34.5 106.2,29.9 112.1,35.2 118,31.9";
	// Last point (118,31.9) → position the tip dot as a % so it stays a round circle.
	const tip = { left: `${(118 / 120) * 100}%`, top: `${(31.9 / 48) * 100}%` };
	return (
		<div className="relative h-full w-full">
			<svg
				viewBox="0 0 120 48"
				preserveAspectRatio="none"
				className="h-full w-full overflow-visible"
			>
				<defs>
					<linearGradient id="aaplFade" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor={ACCENT} stopOpacity="0.35" />
						<stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
					</linearGradient>
				</defs>
				<polygon points={`0,48 ${pts} 118,48`} fill="url(#aaplFade)" />
				<polyline
					points={pts}
					fill="none"
					stroke={ACCENT}
					strokeWidth="1.75"
					strokeLinecap="round"
					strokeLinejoin="round"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			<span
				className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full motion-safe:animate-ping"
				style={{ ...tip, background: ACCENT, opacity: 0.5 }}
			/>
			<span
				className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
				style={{ ...tip, background: ACCENT }}
			/>
		</div>
	);
}

const FIELDS: [string, string, string][] = [
	["Ticker", "AAPL", "string"],
	["Price", "$298.01", "number"],
	["Change", "+0.70%", "percent"],
	["Series", "30 days", "range"],
];

function DataTemplate() {
	return (
		<DemoWindow
			title="FeedForce · Dynamic template"
			badge={<DemoBadge dot>Live data</DemoBadge>}
			label="LIVE DATA BINDING"
			number="03"
		>
			<div className="grid lg:grid-cols-[280px_1fr_280px]">
				<AIBuilderPanel
					placeholder="Connect data to a template…"
					messages={[
						{
							who: "user",
							body: "Bind this template to live stock data for $AAPL.",
						},
						{
							who: "ai",
							body: (
								<BuiltList
									title="Bound 4 fields"
									items={["Ticker", "Price", "Change", "30-day series"]}
								/>
							),
						},
						{ who: "user", body: "Refresh it every hour." },
						{
							who: "ai",
							body: "Set an hourly refresh. It'll re-render automatically with fresh data.",
						},
					]}
				/>

				{/* Data source / bindings (right) — order-last keeps the post centred */}
				<div className="order-last flex flex-col gap-3 border-t border-white/10 bg-white/[0.02] p-4 lg:border-l lg:border-t-0">
					<div className="flex items-center gap-2.5">
						<span className="shrink-0 text-zinc-400">
							<svg
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.8"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden
							>
								<ellipse cx="12" cy="5" rx="8" ry="3" />
								<path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
							</svg>
						</span>
						<div className="min-w-0">
							<div className="text-[13px] font-semibold text-zinc-100">
								Stock API
							</div>
						</div>
						<span className="ml-auto shrink-0">
							<DemoBadge dot className="whitespace-nowrap">
								Custom node
							</DemoBadge>
						</span>
					</div>
					<div className="h-px bg-white/10" />
					<div className="flex items-center justify-between gap-2">
						<span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">
							Bound fields
						</span>
						<span className="text-[11px] text-zinc-500">Refreshed 1m ago</span>
					</div>
					<div className="flex flex-col gap-1.5">
						{FIELDS.map(([k, v, t]) => (
							<div
								key={k}
								className="flex items-center justify-between gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[0.75rem]/[1rem]"
							>
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="text-zinc-500">{k}</span>
									<span className="rounded bg-white/10 px-1 py-0.5 font-mono text-[9px] text-zinc-500">
										{t}
									</span>
								</span>
								<span className="font-mono text-zinc-100">{v}</span>
							</div>
						))}
					</div>
					<p className="text-[11px] leading-relaxed text-zinc-500">
						Each field maps to a slot in your template. Change the data and the
						post re-renders.
					</p>
				</div>

				{/* Rendered post — styled like a real IG carousel slide */}
				<div
					className="flex items-center justify-center bg-black p-6"
					style={GRID_BG_STYLE}
				>
					<div className="relative flex aspect-[4/5] w-56 flex-col overflow-hidden rounded-[4px] bg-zinc-900 ring-1 ring-white/10">
						{/* WHITE top block — meme-template style caption */}
						<div className="bg-white px-3 pb-3 pt-2.5">
							<p className="text-[13px] font-extrabold leading-snug text-black">
								Apple rebounds to $298 after a volatile month
							</p>
						</div>

						{/* dark body — ticker + chart + handle + swipe */}
						<div className="flex flex-1 flex-col p-3">
							<div className="flex items-center justify-between">
								<span className="text-[1rem]/[1.5rem] font-bold tracking-tight text-zinc-100">
									$AAPL
								</span>
								<span
									className="rounded-full px-2 py-0.5 text-[10px] font-bold text-black"
									style={{ background: ACCENT }}
								>
									+0.70%
								</span>
							</div>
							<div className="my-2 min-h-0 flex-1">
								<MiniChart />
							</div>
							<div className="flex items-center justify-between gap-2">
								<span className="text-[10px] font-semibold text-zinc-400">
									@daily.markets
								</span>
								<span className="flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[9px] font-semibold text-zinc-100 backdrop-blur">
									Swipe
									<svg
										width="9"
										height="9"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="3"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden
									>
										<path d="M9 6l6 6-6 6" />
									</svg>
								</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</DemoWindow>
	);
}

export function DataTemplateSection() {
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<SectionIntro
						eyebrow="Dynamic templates"
						title="A design system wired to real-world data"
					>
						Move beyond static posts assembled from screenshots and hand-typed
						figures. Your canvas connects to real-world data and any API
						through custom nodes, so a post built once re-renders each day with
						current, on-brand numbers. Nodes can also execute custom code to
						render animations and far more.
					</SectionIntro>
				</Reveal>

				<Reveal delay={120}>
					<div className="mt-12">
						<DataTemplate />
					</div>
				</Reveal>
			</div>
		</section>
	);
}
