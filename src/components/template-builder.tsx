"use client";

import { useState, type ReactNode } from "react";

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

// Template builder demo — skeleton → brand-kit-filled slide, with a live
// skeleton/filled toggle and a brand-kit lock switch.

// One slot: a dashed labelled placeholder in skeleton view, or the content.
function Slot({
	label,
	skel,
	h,
	children,
}: {
	label: string;
	skel: boolean;
	h?: string;
	children?: ReactNode;
}) {
	if (skel) {
		return (
			<div
				className={`grid place-items-center rounded-md border border-dashed border-white/20 text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-600 ${h || "py-2"}`}
			>
				{label}
			</div>
		);
	}
	return <div className={h}>{children}</div>;
}

function SlideSkeleton({ skel, brandOn }: { skel: boolean; brandOn: boolean }) {
	return (
		<div className="flex aspect-[4/5] flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.04] p-3">
			<Slot label="Logo" skel={skel} h="h-5">
				<span
					style={{ color: brandOn ? ACCENT : "#fafafa" }}
					className="text-[11px] font-bold tracking-tight"
				>
					FEEDFORCE
				</span>
			</Slot>
			<Slot label="Headline" skel={skel}>
				<div className="text-[13px] font-bold leading-tight text-zinc-100">
					5 things to know before your first listing
				</div>
			</Slot>
			<Slot label="Body" skel={skel}>
				<div className="space-y-1">
					<div className="h-1.5 w-full rounded-full bg-white/10" />
					<div className="h-1.5 w-4/5 rounded-full bg-white/10" />
				</div>
			</Slot>
			<div className="mt-auto">
				<Slot label="Image" skel={skel} h="h-16">
					<div
						className="h-16 w-full rounded-md bg-white/10"
						style={brandOn ? { boxShadow: `inset 0 -3px 0 ${ACCENT}` } : undefined}
					/>
				</Slot>
			</div>
		</div>
	);
}

function Segmented({
	value,
	onChange,
	items,
}: {
	value: string;
	onChange: (v: "skeleton" | "filled") => void;
	items: { value: "skeleton" | "filled"; label: string }[];
}) {
	return (
		<div className="flex rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
			{items.map((it) => (
				<button
					key={it.value}
					type="button"
					onClick={() => onChange(it.value)}
					className={`flex-1 rounded-md px-3 py-1.5 text-[0.75rem]/[1rem] font-semibold transition-colors ${
						value === it.value
							? "bg-zinc-100 text-zinc-900"
							: "text-zinc-400 hover:text-zinc-200"
					}`}
				>
					{it.label}
				</button>
			))}
		</div>
	);
}

function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={() => onChange(!checked)}
			className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-zinc-100" : "bg-white/15"}`}
		>
			<span
				className={`absolute top-0.5 size-4 rounded-full transition-transform ${checked ? "translate-x-[18px] bg-black" : "translate-x-0.5 bg-zinc-400"}`}
			/>
		</button>
	);
}

function DemoStudio() {
	const [view, setView] = useState<"skeleton" | "filled">("skeleton");
	const [lockBrand, setLockBrand] = useState(true);
	const skel = view === "skeleton";
	const brandOn = !skel && lockBrand;

	return (
		<DemoWindow
			title="FeedForce · Template builder"
			badge={<DemoBadge dot>Reusable</DemoBadge>}
			label="REUSABLE TEMPLATES"
			number="02"
		>
			<div className="grid lg:grid-cols-[250px_1fr_250px]">
				<AIBuilderPanel
					placeholder="Describe a template…"
					messages={[
						{
							who: "user",
							body: "Make me a carousel skeleton: logo, headline, body, then an image.",
						},
						{
							who: "ai",
							body: (
								<BuiltList
									title="Built 4 slots"
									items={["Logo", "Headline", "Body", "Image"]}
								/>
							),
						},
						{ who: "user", body: "Always use my green as the accent." },
						{
							who: "ai",
							body: "Done. Accent bound to your brand colour. Reuse it on any post.",
						},
					]}
				/>

				{/* Canvas — the skeleton / filled slide + carousel thumbnails */}
				<div
					className="flex flex-col items-center justify-center bg-black p-6"
					style={GRID_BG_STYLE}
				>
					<div className="mx-auto w-full max-w-[200px]">
						<SlideSkeleton skel={skel} brandOn={brandOn} />
					</div>
					<div className="mx-auto mt-3 flex w-full max-w-[200px] gap-2">
						{[0, 1, 2].map((i) => (
							<div
								key={i}
								className="h-9 flex-1 rounded-md border border-white/10 bg-white/[0.04]"
							/>
						))}
					</div>
					<p className="mt-3 text-center text-[11px] text-zinc-500">
						One skeleton · reused across every slide
					</p>
				</div>

				{/* Settings panel */}
				<div className="flex flex-col gap-4 border-t border-white/10 bg-white/[0.02] p-4 lg:border-l lg:border-t-0">
					<Segmented
						value={view}
						onChange={setView}
						items={[
							{ value: "skeleton", label: "Skeleton" },
							{ value: "filled", label: "Filled" },
						]}
					/>
					<div className="h-px bg-white/10" />
					<div>
						<span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">
							Brand kit
						</span>
						<div className="mt-2 flex items-center gap-2.5">
							<span className="flex gap-1">
								{[ACCENT, "#ffffff", "#0a0a0a"].map((c) => (
									<span
										key={c}
										className="size-5 rounded-full border border-white/10"
										style={{ background: c }}
									/>
								))}
							</span>
							<span className="text-[0.75rem]/[1rem] text-zinc-400">Neue Montreal</span>
						</div>
					</div>
					<div className="flex items-center justify-between gap-2">
						<span className="text-[0.75rem]/[1rem] text-zinc-400">Lock to brand kit</span>
						<Toggle
							checked={lockBrand}
							onChange={setLockBrand}
							label="Lock to brand kit"
						/>
					</div>
					<div className="flex flex-wrap gap-1.5">
						<DemoBadge>Auto-layout</DemoBadge>
						<DemoBadge>Reusable</DemoBadge>
						<DemoBadge>Posts to page</DemoBadge>
					</div>
					<span className="grid w-full place-items-center rounded-lg bg-zinc-100 px-3 py-2 text-[0.75rem]/[1rem] font-semibold text-zinc-900">
						Save &amp; reuse
					</span>
					<p className="text-center text-[11px] text-zinc-500">
						Reused 48× this month
					</p>
				</div>
			</div>
		</DemoWindow>
	);
}

const MINI_CARDS: [string, string][] = [
	[
		"Skeletons, not blank canvases",
		"Pre-built slots auto-fill, so every post is laid out and consistent in seconds.",
	],
	[
		"Locked to your brand kit",
		"Fonts, colours and logo apply themselves, so what you build never drifts off-brand.",
	],
	[
		"Wired to post",
		"Each template is a node in your flow that publishes straight to your page.",
	],
];

export function TemplateBuilderSection() {
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<SectionIntro
						eyebrow="Template builder"
						title="Design it once. Reuse it indefinitely."
					>
						Where other tools offer a blank canvas and endless options,
						FeedForce is built around templates. Define a reusable skeleton,
						lock it to your brand kit, and apply it to every post you publish.
					</SectionIntro>
				</Reveal>

				<Reveal delay={120}>
					<div className="mt-12">
						<DemoStudio />
					</div>
				</Reveal>

				<div className="mt-10 grid gap-5 sm:grid-cols-3">
					{MINI_CARDS.map(([t, d], i) => (
						<Reveal key={t} delay={i * 90} className="h-full">
							<div className="h-full rounded-xl border border-white/10 bg-black p-5 transition duration-300 hover:-translate-y-1 hover:border-white/25">
								<h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">
									{t}
								</h3>
								<p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
									{d}
								</p>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
