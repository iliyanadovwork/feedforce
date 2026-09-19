"use client";

import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useJoinNow } from "@/components/join-now";

export function Footer() {
	const join = useJoinNow();
	return (
		<footer className="w-full border-t border-border dark:bg-[radial-gradient(40%_120%_at_12%_0%,--theme(--color-foreground/.06),transparent)]">
			<div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-10 sm:flex-row sm:items-center">
				<div className="flex flex-col gap-4">
					<Link className="w-max" href="/">
						<Logo className="h-6" />
					</Link>
					<p className="max-w-sm text-balance text-muted-foreground text-[0.875rem]/[1.25rem]">
						The Operating System for Content at Scale. AI Agents. Real-Time
						Data. Infinite Distribution.
					</p>
				</div>
				<Button onClick={join}>
					Join Now
				</Button>
			</div>
			<div className="border-t border-border">
				<div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-4 sm:flex-row">
					<p className="font-light text-muted-foreground text-[0.875rem]/[1.25rem]">
						&copy; {new Date().getFullYear()} FeedForce, All rights reserved
					</p>
					<nav className="flex gap-5 text-[0.875rem]/[1.25rem] text-muted-foreground">
						<Link href="/blog" className="transition-colors hover:text-foreground">Blog</Link>
						<Link href="/terms" className="transition-colors hover:text-foreground">Terms of Service</Link>
						<Link href="/privacy" className="transition-colors hover:text-foreground">Privacy Policy</Link>
						<Link href="/refunds" className="transition-colors hover:text-foreground">Refund Policy</Link>
					</nav>
				</div>
			</div>
		</footer>
	);
}
