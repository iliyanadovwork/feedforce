import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
	title: "Terms of Service | FeedForce",
	description: "The terms that govern your use of FeedForce.",
};

export default function TermsPage() {
	return (
		<LegalPage title="Terms of Service" updated="5 July 2026">
			<p>
				These terms are an agreement between you and FeedForce (&quot;we&quot;, &quot;us&quot;),
				the operator of feedforce.ai. They apply as soon as you create an account or use the
				service in any way. If you do not agree with them, please do not use FeedForce.
			</p>

			<h2>1. What FeedForce is</h2>
			<p>
				FeedForce is a studio for creating and distributing social media content. Depending on
				your plan, it lets you design carousel posts and reels from templates, store a brand kit,
				generate design elements and automations with AI, schedule and publish content to
				connected social accounts, and view analytics for what you publish.
			</p>

			<h2>2. Your account</h2>
			<p>
				You need an account to use FeedForce. Keep your password to yourself and tell us promptly
				if you believe someone else has accessed your account. You are responsible for what
				happens under your login. You must be at least 16 years old, or older where your local
				law requires it, and you must give us accurate information when you sign up.
			</p>

			<h2>3. Plans, pricing and billing</h2>
			<p>
				FeedForce has a free plan and a paid subscription (&quot;Pro&quot;). The free plan is
				limited: at the time of writing it includes 3 exports per calendar month, one carousel
				template, one reel template, and 500MB of upload storage with a 100MB limit per file. We
				may adjust these limits, and we will show the current ones inside the product.
			</p>
			<p>
				Pro is a recurring subscription billed in advance. Payments are handled by our payment
				providers: Stripe, or Lemon Squeezy acting as merchant of record. When you buy through
				Lemon Squeezy, your purchase contract for that transaction is with Lemon Squeezy. We do
				not see or store your full card details on our own servers.
			</p>
			<p>
				Subscriptions renew automatically at the end of each billing period until you cancel. You
				can cancel at any time from the Account page; your access then continues until the end of
				the period you already paid for. Refunds are covered by our{" "}
				<a href="/refunds">Refund Policy</a>.
			</p>

			<h2>4. Your content</h2>
			<p>
				Everything you upload or create in FeedForce (images, video, fonts, logos, templates,
				captions) stays yours. So does the content you export. You give us the permission we need
				to host, process, resize, render and transmit that content, purely so the service can
				work: for example storing your uploads, drawing them onto a canvas, rendering an export,
				or sending a finished post to a social platform you connected. We do not sell your
				content and we do not use it to promote FeedForce without your agreement.
			</p>
			<p>
				You are responsible for having the rights to what you upload and publish. That includes
				video you import from a link: pulling in someone&apos;s TikTok, Instagram or X content
				does not give you the right to republish it. Do not use FeedForce to publish anything
				unlawful, deceptive, infringing or hateful, and do not use it to send spam.
			</p>

			<h2>5. AI features</h2>
			<p>
				Some features generate content with the help of third-party AI models. Your prompts, and
				a snapshot of the template you are working on, are sent to the model provider to produce
				the result. AI output can be wrong, generic or similar to output produced for other
				people. Check it before you publish it; you are responsible for what you post.
			</p>

			<h2>6. Connected social accounts</h2>
			<p>
				If you connect a social account, you authorise us to publish the posts you schedule and
				to fetch the analytics those platforms make available. Each platform has its own rules
				and rate limits, and access can break when a platform changes its API. We will do our
				best to keep integrations working but we cannot promise a platform will stay available.
			</p>

			<h2>7. Acceptable use</h2>
			<ul>
				<li>No attempts to break, overload or probe the security of the service.</li>
				<li>No reselling or white-labelling FeedForce without a written agreement with us.</li>
				<li>No scraping other users&apos; data or content.</li>
				<li>No using the free plan with multiple accounts to dodge its limits.</li>
			</ul>
			<p>
				We can suspend or close accounts that break these terms. Where reasonable we will warn
				you first and give you a chance to export your content.
			</p>

			<h2>8. Service changes and availability</h2>
			<p>
				We improve FeedForce continuously, which means features change, get replaced, and
				occasionally get removed. We aim for high availability but the service is provided
				&quot;as is&quot;, without a guarantee of uninterrupted operation. Scheduled posts depend
				on third-party platforms, so we cannot guarantee a post will publish at the exact planned
				moment.
			</p>

			<h2>9. Liability</h2>
			<p>
				To the extent the law allows, our total liability to you for any claim connected with
				FeedForce is limited to the amount you paid us in the 12 months before the claim arose.
				We are not liable for indirect losses such as lost profits, lost audience growth or lost
				data caused by events outside our reasonable control. Nothing in these terms limits
				liability that cannot legally be limited, including for fraud.
			</p>

			<h2>10. Ending the agreement</h2>
			<p>
				You can stop using FeedForce and delete your account at any time by contacting support.
				We can end the agreement if you materially breach these terms, or with 30 days&apos;
				notice if we wind the service down. After account deletion we remove your content from
				our systems within a reasonable period, subject to backups that expire on their own
				schedule.
			</p>

			<h2>11. Changes to these terms</h2>
			<p>
				If we make a material change to these terms we will post the new version here, update the
				date at the top, and where the change matters to existing subscribers we will point it
				out inside the product or by email. Continuing to use FeedForce after a change takes
				effect means you accept the new terms.
			</p>

			<h2>12. Law and disputes</h2>
			<p>
				These terms are governed by the laws of England and Wales, and disputes belong to the
				courts of England and Wales, unless the consumer protection rules where you live give you
				additional rights that apply regardless.
			</p>
		</LegalPage>
	);
}
