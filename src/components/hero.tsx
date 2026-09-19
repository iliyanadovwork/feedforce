"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowRightIcon } from "lucide-react";
import { useJoinNow } from "@/components/join-now";

export function HeroSection() {
	const join = useJoinNow();
	return (
		<section className="mx-auto w-full max-w-6xl">
			{/* Top Shades */}
			<div
				aria-hidden="true"
				className="absolute inset-0 isolate hidden overflow-hidden contain-strict lg:block"
			>
				<div className="absolute inset-0 -top-14 isolate -z-10 bg-[radial-gradient(35%_80%_at_49%_0%,--theme(--color-foreground/.08),transparent)] contain-strict" />
			</div>

			{/* main content */}

			<div className="relative flex flex-col items-center justify-center gap-5 px-2 sm:px-6 pt-28 pb-24 sm:pt-32 sm:pb-28">
				<h1
					className={cn(
						"fade-in slide-in-from-bottom-10 animate-in text-balance fill-mode-backwards text-center font-medium text-[2.25rem]/[2.5rem] tracking-tight delay-100 duration-500 ease-out md:text-[3rem]/[1] lg:text-[3.75rem]/[1]"
					)}
				>
					Control the force <br /> behind the feed.
				</h1>

				<p className="fade-in slide-in-from-bottom-10 mx-auto max-w-xl animate-in fill-mode-backwards text-center text-[1rem]/[1.5rem] text-foreground/80 tracking-wider delay-200 duration-500 ease-out sm:text-[1.125rem]/[1.75rem] md:text-[1.25rem]/[1.75rem]">
					Build automation workflows that turn live signals and news into
					on-brand content, researched, designed, and published across every
					channel before the moment passes.
				</p>

				<div className="fade-in slide-in-from-bottom-10 flex animate-in flex-row flex-wrap items-center justify-center gap-3 fill-mode-backwards pt-2 delay-300 duration-500 ease-out">
					<Button
						className="h-12 rounded-full px-7 text-[1rem]/[1.5rem]"
						size="lg"
						onClick={join}
					>
						Join Now{" "}
						<ArrowRightIcon />
					</Button>
				</div>
			</div>
		</section>
	);
}
