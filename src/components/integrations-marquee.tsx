import type { ReactNode } from "react";

import { SectionIntro } from "@/components/demo-ui";
import { Reveal } from "@/components/reveal";
import { InfiniteSlider } from "@/components/ui/infinite-slider";

// Integrations marquee — two counter-scrolling rows of "logo" chips
// (icon + name) for the data sources a custom node can connect to.

const INTEGRATIONS: { name: string; icon: ReactNode }[] = [
	{
		name: "Stock market",
		icon: (
			<>
				<polyline points="3 17 9 11 13 15 21 7" />
				<polyline points="15 7 21 7 21 13" />
			</>
		),
	},
	{
		name: "Weather",
		icon: <path d="M17 18H7a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1A3.5 3.5 0 0 1 17 18z" />,
	},
	{
		name: "News",
		icon: (
			<>
				<rect x="3" y="4" width="14" height="16" rx="2" />
				<path d="M17 8h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2M6 8h8M6 12h8M6 16h5" />
			</>
		),
	},
	{
		name: "Crypto",
		icon: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M9.5 8.5h4a2 2 0 0 1 0 4h-4zM9.5 12.5h4.5a2 2 0 0 1 0 4h-4.5M11 6.5v11" />
			</>
		),
	},
	{
		name: "Sports",
		icon: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 3a9 9 0 0 0 0 18M3 12h18" />
			</>
		),
	},
	{
		name: "Sheets",
		icon: (
			<>
				<rect x="3" y="3" width="18" height="18" rx="2" />
				<path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
			</>
		),
	},
	{
		name: "Analytics",
		icon: (
			<>
				<line x1="5" y1="20" x2="5" y2="12" />
				<line x1="12" y1="20" x2="12" y2="4" />
				<line x1="19" y1="20" x2="19" y2="9" />
			</>
		),
	},
	{
		name: "Currency",
		icon: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 7v10M14.5 9.2A2.6 2.6 0 0 0 12 8h-.6a2 2 0 0 0 0 4h1.2a2 2 0 0 1 0 4H12a2.6 2.6 0 0 1-2.5-1.2" />
			</>
		),
	},
	{
		name: "Maps",
		icon: (
			<>
				<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z" />
				<circle cx="12" cy="10" r="2.5" />
			</>
		),
	},
	{
		name: "Email",
		icon: (
			<>
				<rect x="3" y="5" width="18" height="14" rx="2" />
				<path d="m3 7 9 6 9-6" />
			</>
		),
	},
	{
		name: "RSS feeds",
		icon: (
			<>
				<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
				<circle cx="5" cy="19" r="1.4" fill="currentColor" stroke="none" />
			</>
		),
	},
	{
		name: "Calendar",
		icon: (
			<>
				<rect x="3" y="4" width="18" height="18" rx="2" />
				<path d="M16 2v4M8 2v4M3 10h18" />
			</>
		),
	},
	{
		name: "Database",
		icon: (
			<>
				<ellipse cx="12" cy="5" rx="8" ry="3" />
				<path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
			</>
		),
	},
	{
		name: "Webhooks",
		icon: (
			<>
				<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
				<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
			</>
		),
	},
];

function IntegrationChip({ name, icon }: { name: string; icon: ReactNode }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5">
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="shrink-0 text-zinc-400"
				aria-hidden
			>
				{icon}
			</svg>
			<span className="whitespace-nowrap text-[13px] font-medium text-zinc-400">
				{name}
			</span>
		</span>
	);
}

export function IntegrationsMarqueeSection() {
	// Rotate the list for the second row so the rows differ.
	const mid = Math.ceil(INTEGRATIONS.length / 2);
	const rowB = [...INTEGRATIONS.slice(mid), ...INTEGRATIONS.slice(0, mid)];

	return (
		<section className="overflow-hidden border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<SectionIntro title="Connect your canvas to any API or data source through custom nodes">
						Configure a node for any API or data source you require, and build
						refined integrations that elevate and accelerate your output.
					</SectionIntro>
				</Reveal>

				<Reveal delay={120}>
					<div className="mt-12 flex flex-col gap-3 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
						<InfiniteSlider gap={12} speed={40}>
							{INTEGRATIONS.map((it) => (
								<IntegrationChip key={it.name} {...it} />
							))}
						</InfiniteSlider>
						<InfiniteSlider gap={12} speed={40} reverse>
							{rowB.map((it) => (
								<IntegrationChip key={it.name} {...it} />
							))}
						</InfiniteSlider>
					</div>
				</Reveal>
			</div>
		</section>
	);
}
