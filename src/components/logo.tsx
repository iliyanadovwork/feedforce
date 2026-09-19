import type React from "react";

import { cn } from "@/lib/utils";

// Icon-only mark (the staggered bars), for compact placements.
export const LogoIcon = (props: React.ComponentProps<"svg">) => (
	<svg
		viewBox="0 0 112 96"
		fill="currentColor"
		xmlns="http://www.w3.org/2000/svg"
		{...props}
	>
		<path d="M18 16 L60 16 L46 36 L4 36 Z" />
		<path d="M18 40 L60 40 L46 60 L4 60 Z" />
		<path d="M18 64 L60 64 L46 84 L4 84 Z" />
		<path d="M64 6 L106 6 L92 26 L50 26 Z" />
		<path d="M64 30 L106 30 L92 50 L50 50 Z" />
		<path d="M64 54 L106 54 L92 74 L50 74 Z" />
	</svg>
);

// Full FeedForce lockup (icon + wordmark) — white SVG, works on any dark surface.
// Light-surface contexts (emails, OG images) should use /feedforce-logo-black.svg instead.
export const Logo = ({
	className,
	...props
}: React.ComponentProps<"img">) => (
	// eslint-disable-next-line @next/next/no-img-element
	<img
		src="/feedforce-logo-white.svg"
		alt="FeedForce"
		className={cn("w-auto select-none", className)}
		{...props}
	/>
);
