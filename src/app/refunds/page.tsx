import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
	title: "Refund Policy | FeedForce",
	description: "How refunds and cancellations work for FeedForce subscriptions.",
};

export default function RefundsPage() {
	return (
		<LegalPage title="Refund Policy" updated="5 July 2026">
			<p>
				We want you to try FeedForce properly before you commit, which is why there is a free
				plan. If you do subscribe and it turns out not to be for you, this page explains exactly
				how refunds and cancellations work.
			</p>

			<h2>Your first payment</h2>
			<p>
				If you are unhappy with your first Pro payment for any reason, contact us within 14 days
				of the charge and we will refund it in full. No forms, no interrogation. Tell us what did
				not work for you if you like; it helps us improve, but it is not a condition of the
				refund.
			</p>

			<h2>Renewals</h2>
			<p>
				Renewal charges can be refunded if you contact us within 14 days of the charge and you
				have not materially used the service since it went through (for example exporting content
				or publishing posts in that period). If you simply forgot to cancel before a renewal,
				write to us; we handle honest cases generously.
			</p>

			<h2>Cancelling</h2>
			<p>
				You can cancel at any time from the Account page inside the app, or through the billing
				portal linked there. Cancelling stops future charges. Your Pro access continues until the
				end of the period you already paid for, and after that your account moves to the free
				plan. Nothing you made is deleted: your templates and uploads stay, with anything above
				the free plan&apos;s limits kept read-only until you either subscribe again or remove it.
			</p>

			<h2>How refunds are paid</h2>
			<p>
				Refunds go back to the original payment method. If you paid through Stripe, we issue the
				refund there. If you paid through Lemon Squeezy, which acts as merchant of record for
				those purchases, the refund is issued through Lemon Squeezy. Either way it typically
				arrives within 5 to 10 business days, depending on your bank.
			</p>

			<h2>What is not refundable</h2>
			<ul>
				<li>Charges older than 14 days, except where the law where you live says otherwise.</li>
				<li>Promotional or discounted periods that were already consumed.</li>
				<li>Free months granted with a redeem code, which have no cash value.</li>
			</ul>

			<h2>Statutory rights</h2>
			<p>
				Nothing here reduces the rights consumer law gives you in your country. If those rights
				are broader than this policy, they win.
			</p>

			<h2>How to request a refund</h2>
			<p>
				Email <a href="mailto:support@feedforce.ai">support@feedforce.ai</a> from the address on
				your account, or use the support chat inside the app, and say which charge you mean. We
				usually respond within one business day.
			</p>
		</LegalPage>
	);
}
