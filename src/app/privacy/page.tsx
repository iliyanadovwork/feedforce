import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
	title: "Privacy Policy | FeedForce",
	description: "What data FeedForce collects, why, and what your rights are.",
};

export default function PrivacyPage() {
	return (
		<LegalPage title="Privacy Policy" updated="5 July 2026">
			<p>
				This page explains what personal data FeedForce collects, what we do with it, and the
				choices you have. The short version: we collect what the product needs to function, we
				share it only with the processors that run the service, and we do not sell it to anyone.
			</p>

			<h2>1. What we collect</h2>
			<h3>Account data</h3>
			<p>
				Your email address and a securely hashed password, managed through our authentication
				provider. If you reset your password, that flow also goes through the same provider.
			</p>
			<h3>Content you create and upload</h3>
			<p>
				Templates, captions, brand kit assets (logos, fonts, colours), images and video you
				upload, and the posts you build from them. This is the core of the product, and it is
				stored so your work is there when you come back.
			</p>
			<h3>Billing data</h3>
			<p>
				Your subscription status, plan, renewal date and payment method summary (for example the
				card brand and last four digits) as reported to us by Stripe or Lemon Squeezy. The full
				card number never touches our servers; it goes directly to the payment provider.
			</p>
			<h3>Connected social accounts</h3>
			<p>
				If you connect a social account for publishing, we store the tokens and profile
				identifiers needed to publish on your behalf, and the analytics the platform reports for
				your posts.
			</p>
			<h3>Support conversations</h3>
			<p>Messages you send through the in-app support chat, so we can reply and keep context.</p>
			<h3>Usage and technical data</h3>
			<p>
				Basic server logs and, on the free plan, usage counters (for example how many exports you
				have used this month). We do not run third-party advertising trackers on the app or the
				landing page.
			</p>

			<h2>2. What we use it for</h2>
			<ul>
				<li>Running the product: storing your work, rendering exports, publishing scheduled posts.</li>
				<li>Billing: knowing which plan you are on and whether a subscription is active.</li>
				<li>Enforcing plan limits on the free tier.</li>
				<li>Answering support messages.</li>
				<li>Security: spotting abuse, rate limiting, and keeping accounts safe.</li>
				<li>Legal obligations, such as tax and accounting records held by our payment providers.</li>
			</ul>
			<p>
				Where the UK GDPR applies, our legal bases are performance of the contract with you,
				legitimate interests in running and protecting the service, and legal obligation for the
				records we must keep.
			</p>

			<h2>3. AI processing</h2>
			<p>
				When you use an AI feature, your prompt and a snapshot of the relevant template or image
				are sent to our AI model provider (currently Google) to generate the result. We send what
				the feature needs and nothing more. We do not use your content to train models.
			</p>

			<h2>4. Who we share data with</h2>
			<p>We use a small set of processors to run FeedForce:</p>
			<ul>
				<li>Supabase, for the database, authentication and file storage.</li>
				<li>Vercel, for hosting the application.</li>
				<li>Stripe and Lemon Squeezy, for payments and subscription management.</li>
				<li>Google, for AI generation features.</li>
				<li>Our social publishing partner, for delivering scheduled posts to connected platforms.</li>
			</ul>
			<p>
				Each of these receives only what its job requires. Some of them process data outside the
				UK and the EU; where that happens, transfers rely on the safeguards those providers offer,
				such as standard contractual clauses. We never sell personal data and we do not share it
				with advertisers.
			</p>

			<h2>5. Cookies and local storage</h2>
			<p>
				We use cookies and browser storage for one purpose: keeping you signed in and remembering
				product state, like which editor you had open. There is no cross-site tracking and there
				are no advertising cookies, which is why you do not see a cookie banner.
			</p>

			<h2>6. How long we keep data</h2>
			<p>
				Your content and account data stay for as long as your account exists. If you delete your
				account, we remove your data from our systems within 30 days, except where our payment
				providers must keep transaction records for tax and accounting law, and except for
				short-lived backups that expire on their own schedule. Support conversations are kept so
				we can maintain context if you contact us again; you can ask us to delete them.
			</p>

			<h2>7. Your rights</h2>
			<p>
				You can ask us for a copy of the personal data we hold about you, ask us to correct it,
				or ask us to delete it. If you are in the UK or the EU you also have the right to object
				to certain processing, to ask for portability, and to complain to your supervisory
				authority (in the UK, the ICO). Email{" "}
				<a href="mailto:support@feedforce.ai">support@feedforce.ai</a> or use the in-app support
				chat and we will respond within a month.
			</p>

			<h2>8. Security</h2>
			<p>
				Data is encrypted in transit, passwords are hashed, database access is restricted by
				row-level security rules, and payment details are handled entirely by our payment
				providers. No system is perfectly secure, but if we ever discover a breach that affects
				your personal data we will inform you and the relevant authority as the law requires.
			</p>

			<h2>9. Children</h2>
			<p>
				FeedForce is not aimed at children and we do not knowingly collect data from anyone under
				16. If you believe a child has created an account, contact us and we will remove it.
			</p>

			<h2>10. Changes to this policy</h2>
			<p>
				If we change this policy in a way that matters, we will update this page and the date at
				the top, and flag the change inside the product or by email where appropriate.
			</p>
		</LegalPage>
	);
}
