import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@/components/ui/avatar";
import { Reveal } from "@/components/reveal";

export function TestimonialsSection() {
	return (
		<Reveal className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center text-center">
			<figure className="flex flex-col items-center justify-center">
			<div className="mb-8 flex items-center gap-2">
				<SonotradeIcon aria-hidden="true" className="size-6 text-foreground" />
				<span className="font-medium text-[1.125rem]/[1.75rem]">Sonotrade</span>
			</div>

			<blockquote className="text-balance text-center text-[1.25rem]/[1.75rem] leading-tight tracking-tight sm:text-[1.5rem]/[2rem] md:text-[1.875rem]/[2.25rem]">
				&quot;<span className="font-medium">FeedForce</span>{" "}turns a market
				move into seven on-brand posts before our desk has finished reading
				the headline. It replaced an entire content team.&quot;
			</blockquote>

			<div className="mask-[linear-gradient(to_right,transparent,black,transparent)] mx-auto my-5 h-px w-full max-w-sm bg-border" />

			<figcaption className="flex flex-col items-center gap-5">
				<div className="space-y-0.5 text-center">
					<cite className="font-medium text-foreground text-[1.25rem]/[1.75rem] not-italic">
						Angel M.
					</cite>
					<div className="text-[1.125rem]/[1.75rem] text-muted-foreground">
						Founder, Sonotrade
					</div>
				</div>

				<Avatar className="size-12 rounded-full border object-cover">
					<AvatarImage alt="Angel Mohamed's profile picture" src="" />
					<AvatarFallback>AM</AvatarFallback>
				</Avatar>
			</figcaption>
			</figure>
		</Reveal>
	);
}

export function SonotradeIcon(props: React.ComponentProps<"svg">) {
	return (
		<svg viewBox="0 0 24 24" fill="none" {...props}>
			<path
				d="M3 16l4-5 4 3 5-8 5 6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
