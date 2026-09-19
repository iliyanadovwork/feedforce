"use client";

import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { useJoinNow, useLogin } from "@/components/join-now";

export function Header() {
	const join = useJoinNow();
	const login = useLogin();
	return (
		<header className="sticky top-0 z-50 w-full border-b border-white/10 bg-black">
			<nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-2 sm:px-6">
				<Link href="/" className="flex items-center">
					<Logo className="h-7 w-auto" />
				</Link>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						className="h-10 rounded-full px-5 text-[0.875rem]/[1.25rem]"
						onClick={login}
					>
						Login
					</Button>
					<Button
						className="h-10 rounded-full px-5 text-[0.875rem]/[1.25rem]"
						onClick={join}
					>
						Signup
					</Button>
				</div>
			</nav>
		</header>
	);
}
