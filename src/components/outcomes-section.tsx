"use client";

import { Button } from "@/components/ui/button";
import { DemoBadge } from "@/components/demo-ui";
import { Reveal } from "@/components/reveal";
import { useJoinNow } from "@/components/join-now";

// Outcomes checklist beside a "this week" content-queue card.

const OUTCOMES = [
	"Go from blank page to a week of posts in one sitting",
	"Keep every post unmistakably on-brand without a designer",
	"Repurpose one idea into carousels, reels and stories",
	"Stay consistent with a queue that posts for you",
];

function Check() {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="3"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

function QueueCard() {
	const rows = [
		{ day: "Mon", label: "Carousel" },
		{ day: "Tue", label: "Reel" },
		{ day: "Wed", label: "Carousel" },
		{ day: "Thu", label: "Reel" },
		{ day: "Fri", label: "Carousel" },
	];
	return (
		<div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.8)]">
			<div className="mb-3 flex items-center justify-between">
				<span className="text-[15px] font-bold text-zinc-100">This week</span>
				<DemoBadge>5 scheduled</DemoBadge>
			</div>
			<div className="h-px bg-white/10" />
			<div className="mt-3 flex flex-col gap-2.5">
				{rows.map((r) => (
					<div
						key={r.day}
						className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3"
					>
						<span className="w-9 text-[0.75rem]/[1rem] font-semibold text-zinc-500">
							{r.day}
						</span>
						<div className="flex-1">
							<div className="h-2 w-2/3 rounded-full bg-white/10" />
							<div className="mt-1.5 h-2 w-1/3 rounded-full bg-white/[0.06]" />
						</div>
						<DemoBadge>{r.label}</DemoBadge>
					</div>
				))}
			</div>
		</div>
	);
}

export function OutcomesSection() {
	const join = useJoinNow();
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<div className="grid items-center gap-12 lg:grid-cols-2">
					<Reveal>
						<h2 className="text-balance text-[2.25rem]/[2.5rem] font-medium tracking-tight sm:text-[3rem]/[1]">
							Built to make showing up effortless
						</h2>
						<p className="mt-4 text-[1rem]/[1.5rem] leading-relaxed text-zinc-400">
							The hard part isn&rsquo;t the idea. It&rsquo;s doing it daily, and
							FeedForce makes that effortless.
						</p>
						<ul className="mt-8 flex flex-col gap-4">
							{OUTCOMES.map((o) => (
								<li key={o} className="flex items-start gap-3">
									<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white text-black">
										<Check />
									</span>
									<span className="text-[1rem]/[1.5rem] leading-relaxed text-zinc-100">
										{o}
									</span>
								</li>
							))}
						</ul>
						<div className="mt-9">
							<Button
								className="h-12 rounded-full bg-zinc-100 px-7 text-[1rem]/[1.5rem] font-medium text-zinc-900 hover:bg-white"
								onClick={join}
							>
								Join Now
							</Button>
						</div>
					</Reveal>

					<Reveal delay={120}>
						<QueueCard />
					</Reveal>
				</div>
			</div>
		</section>
	);
}
