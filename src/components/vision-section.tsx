import { Reveal } from "@/components/reveal";

export function VisionSection() {
	return (
		<section className="border-t border-white/5 px-2 sm:px-6 py-28">
			<div className="mx-auto max-w-3xl">
				<Reveal>
					<p className="text-[0.875rem]/[1.25rem] font-medium uppercase tracking-[0.2em] text-zinc-500">
						Vision
					</p>
				</Reveal>

				<div className="mt-8 space-y-5 text-balance text-[1.5rem]/[2rem] font-medium leading-snug tracking-tight sm:text-[1.875rem]/[2.25rem]">
					<Reveal delay={60}>
						<p>Media used to be created manually.</p>
					</Reveal>
					<Reveal delay={120}>
						<p className="text-zinc-500">
							AI changed the speed, but not the standard.
						</p>
					</Reveal>
					<Reveal delay={180}>
						<p>
							The winning teams will not be the ones posting more. They will
							be the ones controlling the entire content system.
						</p>
					</Reveal>
					<Reveal delay={240}>
						<p>FeedForce is that system.</p>
					</Reveal>
				</div>

				<Reveal delay={300}>
					<div className="mt-10 max-w-xl space-y-3 text-[1rem]/[1.5rem] leading-relaxed text-zinc-400">
						<p>
							Agents monitor what matters, create on-brand assets, publish
							everywhere, and learn from performance.
						</p>
						<p>
							<span className="text-zinc-100">
								Your team sets the direction.
							</span>{" "}
							FeedForce runs the operation.
						</p>
					</div>
				</Reveal>
			</div>
		</section>
	);
}
