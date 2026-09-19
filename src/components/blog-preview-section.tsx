import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { Reveal } from "@/components/reveal";

// Landing-page teaser for the automation-focused posts on /blog. Plain hardcoded
// list (not a fs read from src/lib/blog.ts) so this stays a lightweight import
// inside the 'use client' landing tree — update this array when a new automation
// article should be featured here.
const FEATURED_POSTS = [
	{
		slug: "how-to-create-content-automations",
		title: "How to Create Content Automations",
		description:
			"What to automate first, what to keep human, and a full news-to-post pipeline walkthrough.",
	},
	{
		slug: "feedforce-automation-nodes-explained",
		title: "Every FeedForce Automation Node, Explained",
		description:
			"Trigger, HTTP Request, Custom Agent, Code, If, Apply Template, Element, Post — what each node does.",
	},
	{
		slug: "n8n-alternative-for-content-automation",
		title: "The Best n8n Alternative for Content Automation",
		description:
			"n8n is brilliant for plumbing. Here's where it breaks down for designed, published content — and what to use instead.",
	},
] as const;

export function BlogPreviewSection() {
	return (
		<section className="px-6 py-24">
			<div className="mx-auto max-w-6xl">
				<Reveal>
					<div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
						<h2 className="text-balance text-[2rem]/[1.15] font-medium tracking-tight sm:text-[2.5rem]/[1]">
							Learn how the automations work.
						</h2>
						<Link
							href="/blog"
							className="flex items-center gap-1.5 text-[0.875rem]/[1.25rem] text-zinc-400 transition-colors hover:text-white"
						>
							Read the blog <ArrowRightIcon className="size-3.5" />
						</Link>
					</div>
				</Reveal>

				<div className="mt-10 grid gap-5 md:grid-cols-3">
					{FEATURED_POSTS.map((post, i) => (
						<Reveal key={post.slug} delay={i * 100} className="h-full">
							<Link
								href={`/blog/${post.slug}`}
								className="group flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-black transition duration-300 hover:-translate-y-1 hover:border-white/25"
							>
								{/* eslint-disable-next-line @next/next/no-img-element -- build-time generated card, fixed size */}
								<img
									src={`/blog/${post.slug}/opengraph-image`}
									alt={post.title}
									loading="lazy"
									className="aspect-[1200/630] w-full object-cover"
								/>
								<div className="flex flex-1 flex-col p-5">
									<h3 className="font-medium tracking-tight text-zinc-100 group-hover:underline">
										{post.title}
									</h3>
									<p className="mt-2 text-[0.875rem]/[1.25rem] text-zinc-400">
										{post.description}
									</p>
								</div>
							</Link>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
