import {
	BarChart3,
	ImagePlus,
	LayoutTemplate,
	Repeat2,
	Sparkles,
	Workflow,
} from "lucide-react";

import { Reveal } from "@/components/reveal";

const CAPABILITIES = [
	{
		icon: Workflow,
		title: "Node-based automation",
		description:
			"Connect to any API, from market data and news to Telegram and your own sources, and compose automated content systems with node-based flows.",
	},
	{
		icon: Sparkles,
		title: "Programmatic canvas",
		description:
			"Build anything through conversation with AI. Fetch live datapoints from an API and render chart animations in real time, a capability no other tool offers.",
	},
	{
		icon: LayoutTemplate,
		title: "Template builder",
		description:
			"Create templates freeform, from a structured skeleton, or generate them end to end with AI.",
	},
	{
		icon: ImagePlus,
		title: "Magic fill",
		description:
			"Extend, refine, and complete any image with AI magic fill, faithful to your brand every time.",
	},
	{
		icon: BarChart3,
		title: "Scheduler & analytics",
		description:
			"Plan every post with the built-in scheduler and monitor performance across every channel from a single view.",
	},
	{
		icon: Repeat2,
		title: "Repost from any link",
		description:
			"Retrieve any video from a link and publish it directly to Instagram or TikTok. No downloads, no re-uploads.",
	},
];

export function CapabilitiesSection() {
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal className="text-center">
					<p className="text-[0.875rem]/[1.25rem] font-medium uppercase tracking-[0.2em] text-zinc-500">
						Platform
					</p>
					<h2 className="mx-auto mt-4 max-w-2xl text-balance text-[2.25rem]/[2.5rem] font-medium tracking-tight sm:text-[3rem]/[1]">
						Build any system. Animate it. Automate it.
					</h2>
					<p className="mx-auto mt-4 max-w-xl text-[1rem]/[1.5rem] leading-relaxed text-zinc-400">
						A programmatic canvas for content operations. Architect your system
						once, connect your data sources, and let it run.
					</p>
				</Reveal>

				<div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
					{CAPABILITIES.map((cap, i) => (
						<Reveal key={cap.title} delay={(i % 3) * 90} className="h-full">
							<div className="group flex h-full flex-col rounded-xl border border-white/10 bg-black p-6 transition duration-300 hover:-translate-y-1 hover:border-white/25">
								<cap.icon className="size-6 text-zinc-200" />
								<h3 className="mt-5 text-[1.125rem]/[1.75rem] font-medium tracking-tight">
									{cap.title}
								</h3>
								<p className="mt-2 text-[0.875rem]/[1.25rem] leading-relaxed text-zinc-400">
									{cap.description}
								</p>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
