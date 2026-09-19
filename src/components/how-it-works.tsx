import { ChevronsRight } from "lucide-react";

import { Reveal } from "@/components/reveal";

// Minimalist line-art illustrations (stroke = currentColor, brighten on hover).
// Node graph — connected squares, echoing the automations canvas.
function NodesArt() {
	return (
		<svg viewBox="0 0 280 96" fill="none" className="w-full max-w-[280px]">
			{/* nodes */}
			<rect x="8" y="10" width="32" height="32" rx="6" stroke="currentColor" strokeWidth="1" />
			<rect x="8" y="54" width="32" height="32" rx="6" stroke="currentColor" strokeWidth="1" opacity="0.6" />
			<rect x="124" y="32" width="32" height="32" rx="6" stroke="currentColor" strokeWidth="1" />
			<rect x="240" y="10" width="32" height="32" rx="6" stroke="currentColor" strokeWidth="1" opacity="0.85" />
			<rect x="240" y="54" width="32" height="32" rx="6" stroke="currentColor" strokeWidth="1" opacity="0.6" />
			{/* connectors */}
			<path d="M40 26 H82 V48 H124" stroke="currentColor" strokeWidth="1" opacity="0.5" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M40 70 H82 V48 H124" stroke="currentColor" strokeWidth="1" opacity="0.5" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M156 48 H198 V26 H240" stroke="currentColor" strokeWidth="1" opacity="0.5" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M156 48 H198 V70 H240" stroke="currentColor" strokeWidth="1" opacity="0.5" strokeLinecap="round" strokeLinejoin="round" />
			{/* connection dots */}
			{[
				[40, 26], [40, 70], [124, 48], [156, 48], [240, 26], [240, 70],
			].map(([cx, cy]) => (
				<circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.2" fill="currentColor" opacity="0.8" />
			))}
		</svg>
	);
}

function TemplatesArt() {
	return (
		<svg viewBox="0 0 280 96" fill="none" className="w-full max-w-[280px]">
			{[0, 1, 2, 3, 4, 5].map((i) => (
				<rect
					key={i}
					x={6 + i * 45}
					y="8"
					width="34"
					height="80"
					rx="6"
					stroke="currentColor"
					strokeWidth="1"
					opacity={i === 0 ? 1 : 0.85 - i * 0.12}
				/>
			))}
		</svg>
	);
}

function ChartArt() {
	return (
		<svg viewBox="0 0 280 96" fill="none" className="w-full max-w-[280px]">
			<line
				x1="6"
				y1="78"
				x2="274"
				y2="78"
				stroke="currentColor"
				strokeWidth="1"
				opacity="0.25"
			/>
			<polyline
				points="6,70 66,44 126,58 186,34 274,10"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<polyline
				points="6,74 66,60 126,50 186,56 274,38"
				stroke="currentColor"
				strokeWidth="1"
				strokeLinecap="round"
				strokeLinejoin="round"
				opacity="0.5"
			/>
		</svg>
	);
}

const STEPS = [
	{
		art: NodesArt,
		title: "Automating",
		description:
			"Intelligent node automations connect to real-world data, from markets and news to any API, and convert live signals into content without manual effort.",
		label: "AI NODE AUTOMATIONS",
		number: "01",
	},
	{
		art: TemplatesArt,
		title: "Creating",
		description:
			"Every asset is produced from your templates, preserving your layouts, typography, and tone of voice at any volume.",
		label: "ON-BRAND CREATION",
		number: "02",
	},
	{
		art: ChartArt,
		title: "Measuring",
		description:
			"Measure reach and performance across every channel while agents continuously refine what performs best.",
		label: "PERFORMANCE INSIGHTS",
		number: "03",
	},
];

export function HowItWorks() {
	return (
		<section className="px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<h2 className="text-balance text-center text-[2.25rem]/[2.5rem] font-medium leading-[1.05] tracking-tight sm:text-[3rem]/[1] md:text-[3.75rem]/[1]">
						How FeedForce runs
						<br />
						your content.
					</h2>
				</Reveal>

				<div className="mt-16 grid gap-5 md:grid-cols-3">
					{STEPS.map((step, i) => (
						<Reveal key={step.number} delay={i * 100} className="h-full">
							<article
								className="group flex h-full min-h-[26rem] flex-col rounded-xl border border-white/10 bg-black p-6 transition duration-300 hover:-translate-y-1 hover:border-white/25 sm:min-h-[30rem] sm:p-7"
							>
							<div className="flex h-40 items-start justify-start text-zinc-500 transition-colors duration-300 group-hover:text-zinc-200">
								<step.art />
							</div>

							<div className="mt-auto">
								<h3 className="text-[1.5rem]/[2rem] font-medium tracking-tight">
									{step.title}
								</h3>
								<p className="mt-3 max-w-xs text-[0.875rem]/[1.25rem] leading-relaxed text-zinc-400">
									{step.description}
								</p>
							</div>

							<div className="mt-8 flex items-center justify-between border-t border-white/10 pt-4">
								<span className="font-mono text-[11px] tracking-widest text-zinc-500">
									{step.label}
								</span>
								<span className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-zinc-400">
									{step.number}
									<ChevronsRight className="size-3 text-zinc-200" />
								</span>
							</div>
							</article>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
