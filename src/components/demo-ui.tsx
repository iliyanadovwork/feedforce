import type { CSSProperties, ReactNode } from "react";

import { ChevronsRight } from "lucide-react";

// Shared primitives for the product-demo sections (window-chrome cards, the AI
// chat panel, canvas backgrounds) — ported from the digitalestate marketing
// landing and translated to the FeedForce dark theme.

export const ACCENT = "#00CD40";

// Editor-style grid lines (same 96px grid as the template editor canvas).
export const GRID_BG_STYLE: CSSProperties = {
	backgroundImage:
		"linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.07) 1px, transparent 1px)",
	backgroundSize: "96px 96px",
};

// Dotted canvas for the automations flow editor — small dots, n8n-style.
export const DOT_CANVAS_STYLE: CSSProperties = {
	backgroundImage:
		"radial-gradient(rgba(255,255,255,0.16) 1.2px, transparent 1.2px)",
	backgroundSize: "22px 22px",
};

export function Spark({ color = "currentColor" }: { color?: string }) {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill={color} aria-hidden>
			<path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z" />
		</svg>
	);
}

export function DemoBadge({
	children,
	dot,
	className = "",
}: {
	children: ReactNode;
	dot?: boolean;
	className?: string;
}) {
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-zinc-400 ${className}`}
		>
			{dot && (
				<span
					className="size-1.5 shrink-0 rounded-full"
					style={{ background: ACCENT }}
				/>
			)}
			{children}
		</span>
	);
}

// Window-chrome wrapper every demo sits in (traffic dots + title + badge), styled to
// match the HowItWorks cards: flat black, hairline borders, hover lift + border
// brighten, mono type, and an optional numbered footer strip (label + number chip).
export function DemoWindow({
	title,
	badge,
	label,
	number,
	children,
}: {
	title: string;
	badge?: ReactNode;
	label?: string;
	number?: string;
	children: ReactNode;
}) {
	return (
		<div className="group overflow-hidden rounded-xl border border-white/10 bg-black shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)] transition duration-300 hover:-translate-y-1 hover:border-white/25">
			<div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
				<span className="size-2.5 rounded-full border border-white/15" />
				<span className="size-2.5 rounded-full border border-white/15" />
				<span className="size-2.5 rounded-full border border-white/15" />
				<span className="ml-3 font-mono text-[11px] uppercase tracking-widest text-zinc-500">
					{title}
				</span>
				{badge && <span className="ml-auto">{badge}</span>}
			</div>
			{children}
			{(label || number) && (
				<div className="flex items-center justify-between border-t border-white/10 px-5 py-3.5">
					<span className="font-mono text-[11px] tracking-widest text-zinc-500">
						{label}
					</span>
					{number && (
						<span className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-zinc-400">
							{number}
							<ChevronsRight className="size-3 text-zinc-200" />
						</span>
					)}
				</div>
			)}
		</div>
	);
}

// Centered section intro — eyebrow chip + headline + supporting copy.
export function SectionIntro({
	eyebrow,
	title,
	children,
}: {
	eyebrow?: ReactNode;
	title: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="mx-auto max-w-2xl text-center">
			{eyebrow && (
				<span className="inline-flex items-center gap-2 text-[0.875rem]/[1.25rem] font-medium uppercase tracking-[0.2em] text-zinc-500">
					{eyebrow}
				</span>
			)}
			<h2
				className={`text-balance text-[2.25rem]/[2.5rem] font-medium tracking-tight sm:text-[3rem]/[1] ${eyebrow ? "mt-5" : ""}`}
			>
				{title}
			</h2>
			{children && (
				<p className="mt-4 text-[1rem]/[1.5rem] leading-relaxed text-zinc-400">
					{children}
				</p>
			)}
		</div>
	);
}

export function ChatBubble({
	who,
	children,
}: {
	who: "user" | "ai";
	children: ReactNode;
}) {
	const isUser = who === "user";
	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[90%] rounded-2xl px-3 py-2 text-[0.75rem]/[1rem] leading-relaxed ${
					isUser
						? "bg-white/10 text-zinc-100"
						: "border border-white/10 bg-white/[0.04] text-zinc-400"
				}`}
			>
				{children}
			</div>
		</div>
	);
}

// Reusable checklist body for an "AI built N items" chat message.
export function BuiltList({ title, items }: { title: string; items: string[] }) {
	return (
		<>
			<span className="mb-1.5 flex items-center gap-1.5 font-semibold text-zinc-100">
				<Spark color={ACCENT} /> {title}
			</span>
			<ul className="flex flex-col gap-1">
				{items.map((n) => (
					<li key={n} className="flex items-center gap-1.5 text-zinc-400">
						<span className="grid size-3.5 shrink-0 place-items-center rounded-full bg-white text-black">
							<svg
								width="9"
								height="9"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="3.5"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
						</span>
						{n}
					</li>
				))}
			</ul>
		</>
	);
}

// AI chat panel — always docked on the left of a builder card.
export function AIBuilderPanel({
	messages,
	placeholder = "Describe what you want…",
}: {
	messages: { who: "user" | "ai"; body: ReactNode }[];
	placeholder?: string;
}) {
	return (
		<div className="flex flex-col border-b border-white/10 bg-white/[0.02] lg:border-b-0 lg:border-r">
			<div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
				<span className="shrink-0 translate-y-px">
					<Spark color={ACCENT} />
				</span>
				<span className="text-[13px] font-semibold text-zinc-100">
					AI builder
				</span>
				<span className="ml-auto">
					<DemoBadge dot>online</DemoBadge>
				</span>
			</div>
			<div className="flex flex-1 flex-col gap-3 p-4">
				{messages.map((m, i) => (
					<ChatBubble key={i} who={m.who}>
						{m.body}
					</ChatBubble>
				))}
			</div>
			<div className="border-t border-white/10 p-3">
				<div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] p-1.5 pl-3">
					<span className="flex-1 truncate text-[0.75rem]/[1rem] text-zinc-500">
						{placeholder}
					</span>
					<span
						className="grid size-8 shrink-0 place-items-center rounded-md text-zinc-500"
						aria-label="Send"
					>
						<svg
							width="17"
							height="17"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden
						>
							<path d="M22 2 11 13" />
							<path d="M22 2 15 22l-4-9-9-4z" />
						</svg>
					</span>
				</div>
			</div>
		</div>
	);
}
