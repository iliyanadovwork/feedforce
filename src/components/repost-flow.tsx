import { DemoBadge, DemoWindow, SectionIntro } from "@/components/demo-ui";
import { Reveal } from "@/components/reveal";

// Paste-a-link → fetch → edit → post flow, as a single vertical card.

function StepNum({ n }: { n: number }) {
	return (
		<span className="grid size-5 shrink-0 place-items-center rounded-full bg-white/10 text-[11px] font-bold text-zinc-300">
			{n}
		</span>
	);
}

function MiniButton({ children, full }: { children: React.ReactNode; full?: boolean }) {
	return (
		<span
			className={`inline-flex shrink-0 items-center justify-center rounded-md bg-zinc-100 px-3 py-1.5 text-[0.75rem]/[1rem] font-semibold text-zinc-900 ${full ? "w-full" : ""}`}
		>
			{children}
		</span>
	);
}

function FlowArrow() {
	return (
		<div className="my-3.5 flex items-center gap-2 text-zinc-600">
			<span className="h-px flex-1 bg-white/10" />
			<svg
				width="15"
				height="15"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden
			>
				<path d="M12 5v14M19 12l-7 7-7-7" />
			</svg>
			<span className="h-px flex-1 bg-white/10" />
		</div>
	);
}

export function RepostFlow() {
	return (
		<DemoWindow
			title="FeedForce · Repost"
			badge={<DemoBadge dot>One paste</DemoBadge>}
			label="ONE-PASTE REPOST"
			number="04"
		>
			<div className="p-5">
			{/* Step 1 — paste the link */}
			<div className="flex items-center justify-between gap-2">
				<span className="flex items-center gap-2 text-[0.75rem]/[1rem] font-semibold uppercase tracking-[0.14em] text-zinc-500">
					<StepNum n={1} /> Paste a link
				</span>
				<div className="flex flex-wrap justify-end gap-1.5">
					{["TikTok", "Instagram", "X", "YouTube"].map((p) => (
						<DemoBadge key={p}>{p}</DemoBadge>
					))}
				</div>
			</div>
			<div className="mt-2.5 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] p-1.5 pl-3">
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="shrink-0 text-zinc-500"
					aria-hidden
				>
					<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
					<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
				</svg>
				<span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]/[1rem] text-zinc-400">
					https://www.tiktok.com/@creator/video/7359…
				</span>
				<MiniButton>Fetch</MiniButton>
			</div>

			<FlowArrow />

			{/* Step 2 — edit & rebrand */}
			<div className="flex items-center justify-between gap-2">
				<span className="flex items-center gap-2 text-[0.75rem]/[1rem] font-semibold uppercase tracking-[0.14em] text-zinc-500">
					<StepNum n={2} /> Edit &amp; rebrand
				</span>
				<DemoBadge>Brand kit</DemoBadge>
			</div>
			<div className="mt-2.5 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
				<div className="relative aspect-[9/16] w-12 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/10">
					<span className="absolute left-1/2 top-1/2 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-black">
						<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
							<path d="M8 5v14l11-7z" />
						</svg>
					</span>
				</div>
				<div className="min-w-0 flex-1">
					<p className="truncate text-[0.75rem]/[1rem] text-zinc-400">
						&ldquo;5 things I wish I knew before my first listing…&rdquo;
					</p>
					<div className="mt-1.5 flex flex-wrap gap-1.5">
						<DemoBadge>Caption</DemoBadge>
						<DemoBadge>Fonts</DemoBadge>
						<DemoBadge>Crop</DemoBadge>
					</div>
				</div>
				<MiniButton>Edit</MiniButton>
			</div>

			<FlowArrow />

			{/* Step 3 — post to your page */}
			<div className="flex items-center justify-between gap-2">
				<span className="flex items-center gap-2 text-[0.75rem]/[1rem] font-semibold uppercase tracking-[0.14em] text-zinc-500">
					<StepNum n={3} /> Post to your page
				</span>
				<DemoBadge dot>Ready</DemoBadge>
			</div>
			<div className="mt-2.5">
				<MiniButton full>Post to your page</MiniButton>
			</div>
			<p className="mt-2.5 text-center text-[0.75rem]/[1rem] text-zinc-500">
				No download · no re-upload · no AirDrop
			</p>
			</div>
		</DemoWindow>
	);
}

export function RepostFlowSection() {
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<SectionIntro
						eyebrow="Repost in one paste"
						title="From TikTok to Instagram, straight from a link"
					>
						Paste a link from{" "}
						<span className="text-zinc-100">TikTok, Instagram, X or YouTube</span>{" "}
						and FeedForce fetches the video and caption. Rebrand it with your
						brand kit, tweak it in the editor, then post straight to your page.
					</SectionIntro>
					<p className="mx-auto mt-4 max-w-2xl text-center text-[1rem]/[1.5rem] font-medium leading-relaxed text-zinc-100">
						No downloads. No re-uploads. No AirDrop.
					</p>
				</Reveal>

				<Reveal delay={120}>
					<div className="mx-auto mt-12 max-w-md">
						<RepostFlow />
					</div>
				</Reveal>
			</div>
		</section>
	);
}
