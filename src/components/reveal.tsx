"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// Fades + slides content up the first time it scrolls into view.
export function Reveal({
	children,
	className,
	delay = 0,
}: {
	children: React.ReactNode;
	className?: string;
	delay?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [shown, setShown] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) {
					setShown(true);
					io.disconnect();
				}
			},
			{ threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	return (
		<div
			ref={ref}
			style={{ transitionDelay: shown ? `${delay}ms` : "0ms" }}
			className={cn(
				"transition-all duration-700 ease-out motion-reduce:transition-none",
				shown
					? "translate-y-0 opacity-100 blur-0"
					: "translate-y-5 opacity-0 blur-[2px]",
				className
			)}
		>
			{children}
		</div>
	);
}
