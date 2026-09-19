"use client";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

export type InfiniteSliderProps = {
	children: React.ReactNode;
	gap?: number;
	speed?: number;
	speedOnHover?: number;
	direction?: "horizontal" | "vertical";
	reverse?: boolean;
	className?: string;
};

// Marquee driven by the Web Animations API: two identical groups, each with a
// trailing gap, so a translate to -50% loops seamlessly. WAAPI rather than a
// CSS animation because the hover slow-down must change speed WITHOUT moving
// the strip — rewriting animation-duration on a running CSS animation re-maps
// the elapsed time against the new duration and the strip visibly jumps;
// adjusting playbackRate keeps the current position exact. (Keyframes are
// literal translate values — iOS Safari won't animate a transform built from
// a CSS custom prop, which also rules out the var()-driven CSS approach.)
export function InfiniteSlider({
	children,
	gap = 16,
	speed = 100,
	speedOnHover,
	direction = "horizontal",
	reverse = false,
	className,
}: InfiniteSliderProps) {
	const stripRef = useRef<HTMLDivElement>(null);
	const groupRef = useRef<HTMLDivElement>(null);
	const animRef = useRef<Animation | null>(null);
	const hoveredRef = useRef(false);
	// Loop position that outlives the Animation object. `children` is in the effect deps and gets
	// a fresh identity on every parent render, so the effect re-runs (cleanup → rebuild) far more
	// often than the content actually changes — without this ref each re-render would restart the
	// strip at zero, a visible snap whenever ancestor state changes (auth events on tab focus, the
	// auth overlay opening, etc.).
	const fractionRef = useRef(0);

	const isHorizontal = direction === "horizontal";

	useEffect(() => {
		const strip = stripRef.current;
		const group = groupRef.current;
		if (!strip || !group) return;

		// Snapshot the live animation's loop fraction into fractionRef (no-op if none is running).
		const saveFraction = () => {
			const anim = animRef.current;
			const duration = Number(anim?.effect?.getTiming().duration ?? 0);
			if (anim && duration > 0) {
				fractionRef.current = (Number(anim.currentTime ?? 0) % duration) / duration;
			}
		};

		const rebuild = () => {
			const size = isHorizontal ? group.scrollWidth : group.scrollHeight;
			const distance = size + gap; // one group + its trailing gap
			if (distance <= 0 || speed <= 0) return;

			saveFraction();
			animRef.current?.cancel();

			const duration = (distance / speed) * 1000;
			const axis = isHorizontal ? "translateX" : "translateY";
			const anim = strip.animate(
				[{ transform: `${axis}(0)` }, { transform: `${axis}(-50%)` }],
				{
					duration,
					iterations: Infinity,
					easing: "linear",
					direction: reverse ? "reverse" : "normal",
				},
			);
			anim.currentTime = fractionRef.current * duration;
			anim.playbackRate = hoveredRef.current && speedOnHover ? speedOnHover / speed : 1;
			animRef.current = anim;
		};

		rebuild();
		const ro = new ResizeObserver(rebuild);
		ro.observe(group);
		return () => {
			ro.disconnect();
			// Cleanup runs before the next effect pass, so park the position where the next
			// rebuild (or a remount) can pick it up in place instead of restarting at zero.
			saveFraction();
			animRef.current?.cancel();
			animRef.current = null;
		};
	}, [isHorizontal, gap, speed, speedOnHover, reverse, children]);

	const setHovered = (value: boolean) => {
		hoveredRef.current = value;
		const anim = animRef.current;
		if (!anim || !speedOnHover || speed <= 0) return;
		anim.playbackRate = value ? speedOnHover / speed : 1;
	};

	const groupStyle: React.CSSProperties = {
		gap: `${gap}px`,
		flexDirection: isHorizontal ? "row" : "column",
		...(isHorizontal
			? { marginInlineEnd: `${gap}px` }
			: { marginBlockEnd: `${gap}px` }),
	};

	return (
		<div className={cn("overflow-hidden", className)}>
			<div
				ref={stripRef}
				className="flex w-max will-change-transform"
				style={{ flexDirection: isHorizontal ? "row" : "column" }}
				onMouseEnter={speedOnHover ? () => setHovered(true) : undefined}
				onMouseLeave={speedOnHover ? () => setHovered(false) : undefined}
			>
				<div ref={groupRef} className="flex w-max shrink-0" style={groupStyle}>
					{children}
				</div>
				<div aria-hidden className="flex w-max shrink-0" style={groupStyle}>
					{children}
				</div>
			</div>
		</div>
	);
}
