"use client";

import { cn } from "@/lib/utils";
import { InfiniteSlider } from "@/components/ui/infinite-slider";
import post1 from "@/assets/opt/IMG_5557.jpg";
import post3 from "@/assets/opt/IMG_5560.jpg";
import post5 from "@/assets/opt/post5.jpg";
import post6 from "@/assets/opt/post6.jpg";
import post7 from "@/assets/opt/post7.jpg";
import ex1 from "@/assets/opt/ex1.jpg";
import ex2 from "@/assets/opt/ex2.png";
import ex3 from "@/assets/opt/ex3.jpg";
import ex4 from "@/assets/opt/ex4.png";
import ex5 from "@/assets/opt/ex5.jpg";
import ex6 from "@/assets/opt/ex6.jpg";
import ex7 from "@/assets/opt/ex7.jpg";
import ex8 from "@/assets/opt/ex8.png";
import ex9 from "@/assets/opt/ex9.jpg";

// Keep each image's intrinsic width/height so cards reserve the exact aspect
// ratio before the image loads — no layout shift, no marquee re-measure glitch.
const posts = [
	{ img: post1, alt: "Example post" },
	{ img: ex1, alt: "Example post" },
	{ img: post6, alt: "Example post" },
	{ img: ex2, alt: "Example post" },
	{ img: post3, alt: "Example post" },
	{ img: ex3, alt: "Example post" },
	{ img: post5, alt: "Example post" },
	{ img: ex4, alt: "Example post" },
	{ img: ex5, alt: "Example post" },
	{ img: post7, alt: "Example post" },
	{ img: ex6, alt: "Example post" },
	{ img: ex7, alt: "Example post" },
	{ img: ex8, alt: "Example post" },
	{ img: ex9, alt: "Example post" },
].map(({ img, alt }) => ({
	src: img.src,
	alt,
	ratio: `${img.width} / ${img.height}`,
}));

const MASK =
	"mask-[linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]";

type PostsMarqueeProps = {
	label?: string;
	align?: "left" | "center";
	className?: string;
	/** Number of lanes; each one scrolls opposite to its neighbour. */
	rows?: number;
	/** Tailwind height classes for each post card */
	heightClassName?: string;
	/** Pixel gap between cards and lanes */
	gap?: number;
	/** Tile each lane this many times so it fills wide containers (e.g. backgrounds). */
	repeat?: number;
	/** Per-card extra classes (e.g. rounded-lg for mini boxes). */
	cardClassName?: string;
};

function PostCard({
	src,
	alt,
	ratio,
	heightClassName,
	cardClassName,
}: {
	src: string;
	alt: string;
	ratio: string;
	heightClassName: string;
	cardClassName?: string;
}) {
	return (
		<div
			className={cn("group/post shrink-0", heightClassName)}
			style={{ aspectRatio: ratio }}
		>
			<img
				src={src}
				alt={alt}
				loading="lazy"
				decoding="async"
				className={cn(
					"h-full w-full select-none rounded-2xl border border-white/10 object-cover shadow-2xl shadow-black/60 transition duration-300 group-hover/post:border-white/30 group-hover/post:brightness-110",
					cardClassName
				)}
			/>
		</div>
	);
}

export function PostsMarquee({
	label = "Trusted by leading channels",
	align = "left",
	className,
	rows = 1,
	heightClassName = "h-60 sm:h-72 lg:h-[24rem]",
	gap = 20,
	repeat = 1,
	cardClassName,
}: PostsMarqueeProps) {
	// One lane per row, each offset so they don't mirror, alternating direction.
	// Tile each lane `repeat` times so it fills wide containers and never leaves gaps.
	const lanes = Array.from({ length: rows }, (_, i) => {
		const shift = i % posts.length;
		const base = [...posts.slice(shift), ...posts.slice(0, shift)];
		const items = Array.from({ length: Math.max(1, repeat) }, () => base).flat();
		return { items, reverse: i % 2 === 0 };
	});

	return (
		<div className={cn("mt-14", className)}>
			{label ? (
				<p
					className={cn(
						"text-[0.75rem]/[1rem] uppercase tracking-widest text-zinc-600",
						align === "center" && "text-center"
					)}
				>
					{label}
				</p>
			) : null}

			<div
				className={cn("flex flex-col", label && "mt-8")}
				style={{ gap: `${gap}px` }}
			>
				{lanes.map((lane, i) => (
					<div key={`lane-${i}`} className={MASK}>
						<InfiniteSlider
							gap={gap}
							reverse={lane.reverse}
							speed={55}
							speedOnHover={14}
						>
							{lane.items.map((post, j) => (
								<PostCard
									key={`${i}-${j}-${post.src}`}
									src={post.src}
									alt={post.alt}
									ratio={post.ratio}
									heightClassName={heightClassName}
									cardClassName={cardClassName}
								/>
							))}
						</InfiniteSlider>
					</div>
				))}
			</div>
		</div>
	);
}
