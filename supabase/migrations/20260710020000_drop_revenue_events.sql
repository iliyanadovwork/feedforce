-- Revert 20260710010000_revenue_events.sql: the revenue-ledger approach was replaced by querying
-- Stripe live in /api/admin/revenue (src/lib/stripe.ts's listPaidStripeInvoices) — no local table
-- needed, so drop what was applied.
drop function if exists public.admin_monthly_revenue();
drop table if exists public.revenue_events;
