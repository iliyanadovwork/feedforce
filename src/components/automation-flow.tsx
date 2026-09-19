import type { ReactNode } from "react";

import {
	ACCENT,
	AIBuilderPanel,
	BuiltList,
	DemoBadge,
	DemoWindow,
	DOT_CANVAS_STYLE,
	SectionIntro,
} from "@/components/demo-ui";
import { Reveal } from "@/components/reveal";

// AI automation builder — an AI chat panel beside an n8n-style canvas of square
// nodes, presented as if the user described the flow and the AI wired it up.

type HandleSide = "top" | "bottom" | "left" | "right";

const NODES: {
	type: string;
	title: string;
	sub: string;
	icon: ReactNode;
	edge?: string;
	approval?: boolean;
	handles?: HandleSide[];
}[] = [
	{
		type: "Trigger",
		title: "Fetch post",
		sub: "Grabs the video + caption from a pasted link",
		edge: "content",
		handles: ["right"],
		icon: (
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
				<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
				<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
			</svg>
		),
	},
	{
		type: "API",
		title: "API call",
		sub: "Pulls live data from any API",
		edge: "data",
		handles: ["left", "right"],
		icon: (
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
				<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
			</svg>
		),
	},
	{
		type: "Transform",
		title: "Apply template",
		sub: "Meshes it into your branded layout",
		edge: "approved?",
		handles: ["left", "bottom"],
		icon: (
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
				<rect x="3" y="3" width="18" height="18" rx="2" />
				<path d="M3 9h18M9 21V9" />
			</svg>
		),
	},
	{
		type: "Approval",
		title: "Telegram check",
		sub: "Asks you to approve before it posts",
		edge: "on yes",
		approval: true,
		handles: ["top", "right"],
		icon: (
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
				<path d="M21 4 3 11l6 2 2 6 3-4 4 3z" />
			</svg>
		),
	},
	{
		type: "Action",
		title: "Schedule",
		sub: "Queues it to your connected pages",
		handles: ["left"],
		icon: (
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
				<rect x="3" y="4" width="18" height="18" rx="2" />
				<path d="M16 2v4M8 2v4M3 10h18" />
			</svg>
		),
	},
];

function SideHandle({ side }: { side: HandleSide }) {
	const pos: Record<HandleSide, string> = {
		top: "-top-1.5 left-1/2 -translate-x-1/2",
		bottom: "-bottom-1.5 left-1/2 -translate-x-1/2",
		left: "-left-1.5 top-1/2 -translate-y-1/2",
		right: "-right-1.5 top-1/2 -translate-y-1/2",
	};
	return (
		<span
			aria-hidden
			className={`absolute size-3 rounded-full border-2 border-white/15 bg-zinc-900 ${pos[side]}`}
		/>
	);
}

function NodeCard({
	type,
	title,
	sub,
	icon,
	approval,
	handles = ["left", "right"],
}: (typeof NODES)[number]) {
	return (
		<div className="relative flex size-[168px] shrink-0 flex-col rounded-xl border border-white/10 bg-black p-3.5">
			{handles.map((h) => (
				<SideHandle key={h} side={h} />
			))}
			<div className="flex items-center justify-between">
				<span className="shrink-0 text-zinc-400">{icon}</span>
				<span
					className="size-1.5 rounded-full"
					style={{ background: ACCENT }}
					title="Active"
				/>
			</div>
			<div className="mt-auto">
				<span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
					{type}
				</span>
				<div className="mt-0.5 text-[13px] font-semibold leading-tight text-zinc-100">
					{title}
				</div>
				<div className="mt-1 text-[11px] leading-snug text-zinc-500">{sub}</div>
				{approval && (
					<div className="flex gap-1.5 pt-2">
						<span className="rounded bg-white px-2 py-0.5 text-[10px] font-bold text-black">
							Yes
						</span>
						<span className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
							No
						</span>
					</div>
				)}
			</div>
		</div>
	);
}

// Horizontal connector spanning the full gap so the animated dashed arrow runs
// from one node's right handle to the next node's left handle.
function NodeConnector({ label }: { label?: string }) {
	return (
		<div
			className="relative z-10 flex w-[46px] shrink-0 items-center text-zinc-600"
			aria-hidden
		>
			<svg
				width="46"
				height="12"
				viewBox="0 0 46 12"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="overflow-visible"
			>
				<path d="M0 6 H40" strokeDasharray="3 3" className="dash-flow" />
				<path d="M39 1.5l7 4.5-7 4.5z" fill="currentColor" />
			</svg>
			{label && (
				<span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[13px] whitespace-nowrap text-[8px] font-medium uppercase tracking-wide">
					{label}
				</span>
			)}
		</div>
	);
}

// Orthogonal connector that drops from `fromX` (bottom of a top-row node)
// across to `toX` and down into the top of a bottom-row node.
function ElbowConnector({
	width,
	fromX,
	toX,
	label,
}: {
	width: number;
	fromX: number;
	toX: number;
	label?: string;
}) {
	const mid = (fromX + toX) / 2;
	return (
		<div className="relative z-10" style={{ width, height: 36 }} aria-hidden>
			<svg
				width={width}
				height="36"
				viewBox={`0 0 ${width} 36`}
				fill="none"
				className="overflow-visible text-zinc-600"
			>
				<path
					d={`M${fromX} 0 V18 H${toX} V36`}
					stroke="currentColor"
					strokeWidth="1.6"
					strokeDasharray="3 3"
					className="dash-flow"
				/>
				<path
					d={`M${toX - 4.5} 30 L${toX} 36 L${toX + 4.5} 30 Z`}
					fill="currentColor"
					stroke="currentColor"
					strokeWidth="1"
					strokeLinejoin="round"
				/>
			</svg>
			{label && (
				<span
					className="absolute top-[6px] -translate-x-1/2 text-[8px] font-medium uppercase tracking-wide text-zinc-600"
					style={{ left: mid }}
				>
					{label}
				</span>
			)}
		</div>
	);
}

export function AutomationFlowSection() {
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<SectionIntro
						eyebrow="AI node automations"
						title="Automate your whole workflow, just by chatting"
					>
						Describe what you want and the AI wires up the nodes for you. Build
						the flow once and it runs on repeat.
					</SectionIntro>
				</Reveal>

				<Reveal delay={120}>
					<div className="mt-12">
						<DemoWindow
							title="FeedForce · Automations"
							badge={<DemoBadge dot>AI-built</DemoBadge>}
							label="AI NODE AUTOMATIONS"
							number="01"
						>
							<div className="grid lg:grid-cols-[320px_1fr]">
								<AIBuilderPanel
									placeholder="Describe an automation…"
									messages={[
										{
											who: "user",
											body: "When I paste a TikTok link, brand it and ask me on Telegram before scheduling.",
										},
										{
											who: "ai",
											body: (
												<BuiltList
													title="Built 5 nodes"
													items={[
														"Fetch post",
														"API call",
														"Apply template",
														"Telegram check",
														"Schedule",
													]}
												/>
											),
										},
										{
											who: "user",
											body: <>Only post if it&rsquo;s longer than 15 seconds.</>,
										},
										{
											who: "ai",
											body: (
												<>
													Added a condition to the Fetch node. Want a fallback
													if it&rsquo;s shorter?
												</>
											),
										},
									]}
								/>

								{/* Node canvas — 3 nodes on top (Fetch → API → Apply), 2 below
								    (Telegram → Schedule). Geometry (NODE 168 + CONNECTOR 46):
								    top row = 596 wide, Apply centre = 512; bottom row = 382,
								    centred under it so Telegram centre = 191. */}
								<div
									className="overflow-x-auto p-6 sm:p-8"
									style={DOT_CANVAS_STYLE}
								>
									<div className="mx-auto flex w-max flex-col items-center">
										<div className="flex items-center">
											<NodeCard {...NODES[0]} />
											<NodeConnector label={NODES[0].edge} />
											<NodeCard {...NODES[1]} />
											<NodeConnector label={NODES[1].edge} />
											<NodeCard {...NODES[2]} />
										</div>
										<ElbowConnector
											width={596}
											fromX={512}
											toX={191}
											label={NODES[2].edge}
										/>
										<div className="flex items-center">
											<NodeCard {...NODES[3]} />
											<NodeConnector label={NODES[3].edge} />
											<NodeCard {...NODES[4]} />
										</div>
									</div>
								</div>
							</div>
						</DemoWindow>
					</div>
				</Reveal>
			</div>
		</section>
	);
}
