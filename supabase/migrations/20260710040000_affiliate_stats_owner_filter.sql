-- Defense-in-depth: put an explicit owner filter INSIDE the affiliate self-service stats functions.
--
-- Both functions are SECURITY INVOKER and were relying ENTIRELY on the owner-read RLS policy on
-- affiliate_commissions/affiliate_referrals to scope their sums to the caller. That is one policy away
-- from disaster: if that RLS policy is ever dropped or disabled (a routine ops mistake), every affiliate
-- would see the platform's TOTAL commissions/revenue. Adding `affiliate_id in (my affiliate ids)` makes
-- the scoping intrinsic to the query, so RLS becomes the second layer, not the only one.
--
-- Signatures are unchanged, so the client callers (affiliate_self_stats / affiliate_monthly_revenue) are
-- unaffected. `(select auth.uid())` is wrapped in a subselect per Supabase's init-plan guidance.

create or replace function public.affiliate_self_stats()
returns table (referrals bigint, earned_cents bigint, unpaid_cents bigint, paid_cents bigint, clawback_cents bigint)
language sql security invoker set search_path = public as $$
  with mine as (select id from public.affiliates where user_id = (select auth.uid()))
  select
    (select count(*) from public.affiliate_referrals where affiliate_id in (select id from mine)),
    coalesce((select sum(commission_cents) from public.affiliate_commissions
      where reversed_at is null and affiliate_id in (select id from mine)), 0),
    coalesce((select sum(commission_cents) from public.affiliate_commissions
      where reversed_at is null and paid_out_at is null and affiliate_id in (select id from mine)), 0),
    coalesce((select sum(commission_cents) from public.affiliate_commissions
      where reversed_at is null and paid_out_at is not null and affiliate_id in (select id from mine)), 0),
    coalesce((select sum(commission_cents) from public.affiliate_commissions
      where reversed_at is not null and paid_out_at is not null and affiliate_id in (select id from mine)), 0);
$$;
revoke execute on function public.affiliate_self_stats() from public, anon;
grant execute on function public.affiliate_self_stats() to authenticated;

create or replace function public.affiliate_monthly_revenue()
returns table (month date, commission_cents bigint)
language sql security invoker set search_path = public as $$
  select date_trunc('month', c.created_at)::date, sum(c.commission_cents)
  from public.affiliate_commissions c
  where c.reversed_at is null
    and c.affiliate_id in (select id from public.affiliates where user_id = (select auth.uid()))
  group by 1
  order by 1;
$$;
revoke execute on function public.affiliate_monthly_revenue() from public, anon;
grant execute on function public.affiliate_monthly_revenue() to authenticated;
