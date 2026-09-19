import Link from "next/link";
import { Logo } from "@/components/logo";

// Shared shell for the legal pages (/terms, /privacy, /refunds). Standalone dark pages in the
// landing's visual register, deliberately free of app tokens so they render the same for
// logged-out visitors and payment-provider reviewers.

export function LegalPage({
	title,
	updated,
	children,
}: {
	title: string;
	updated: string;
	children: React.ReactNode;
}) {
	return (
		<div className="min-h-screen bg-black text-zinc-200">
			<header className="border-b border-white/10">
				<div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-6">
					<Link href="/" aria-label="FeedForce home">
						<Logo className="h-6 w-auto" />
					</Link>
					<nav className="flex gap-5 text-[0.8125rem] text-zinc-400">
						<Link href="/terms" className="hover:text-white">Terms</Link>
						<Link href="/privacy" className="hover:text-white">Privacy</Link>
						<Link href="/refunds" className="hover:text-white">Refunds</Link>
					</nav>
				</div>
			</header>

			<main className="mx-auto w-full max-w-3xl px-6 py-14">
				<h1 className="text-3xl font-bold tracking-tight text-white">{title}</h1>
				<p className="mt-2 text-sm text-zinc-500">Last updated: {updated}</p>
				<div className="legal-body mt-10 space-y-4 text-[0.9375rem] leading-7 text-zinc-300 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-white [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1.5 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-white">
					{children}
				</div>
			</main>

			<footer className="border-t border-white/10">
				<p className="mx-auto max-w-3xl px-6 py-6 text-sm text-zinc-500">
					Questions about this page? Write to us at{" "}
					<a href="mailto:support@feedforce.ai">support@feedforce.ai</a> or use the
					support chat inside the app.
				</p>
			</footer>
		</div>
	);
}
