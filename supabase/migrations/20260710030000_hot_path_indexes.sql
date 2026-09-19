-- Hot-path indexes.
--
-- Postgres does NOT auto-create an index on the *child* column of a foreign key, so every
-- `.eq('user_id', …)` / `.eq('post_id', …)` / `.in('post_id', ids)` in the app is a sequential scan
-- that grows linearly with table size. These indexes match the real access patterns (filter column +
-- the column we order by) used across the editor, schedule, cron and affiliate surfaces.
--
-- All are `if not exists`, so this is safe to run repeatedly and safe if some already exist.
-- NOTE: on a large, live table a plain CREATE INDEX briefly locks writes. If any of these tables is
-- already big, run that one statement as `create index concurrently …` in the SQL editor instead
-- (concurrent builds can't run inside a migration transaction).

-- Carousel editor: posts + their slides (CarouselHomeGrid, SchedulePanel, useTemplateEditor, render).
create index if not exists idx_te_posts_user_position        on public.template_editor_posts (user_id, position);
create index if not exists idx_te_posts_folder                on public.template_editor_posts (folder_id);
create index if not exists idx_te_post_slides_post_position   on public.template_editor_post_slides (post_id, position);

-- Templates + their slides.
create index if not exists idx_te_templates_user_position     on public.template_editor_templates (user_id, position);
create index if not exists idx_te_slides_template_position    on public.template_editor_slides (template_id, position);

-- Per-user library tables (loaded on nearly every authenticated page).
create index if not exists idx_twitter_templates_user         on public.twitter_templates (user_id, position);
create index if not exists idx_custom_elements_user           on public.custom_elements (user_id);
create index if not exists idx_carousel_folders_user_position on public.carousel_folders (user_id, position);

-- Subscriptions: the auth/gate hot path (useSubscription runs on essentially every authed request) plus
-- the webhook customer lookups. (ls_subscription_id / stripe_subscription_id are already UNIQUE-indexed.)
create index if not exists idx_subscriptions_user             on public.subscriptions (user_id);
create index if not exists idx_subscriptions_stripe_customer  on public.subscriptions (stripe_customer_id);

-- Automations: the cron reads the latest run per flow; runs/credentials are listed per user/flow.
create index if not exists idx_automations_user              on public.automations (user_id);
create index if not exists idx_automation_runs_auto_started  on public.automation_runs (automation_id, started_at desc);
create index if not exists idx_automation_runs_user          on public.automation_runs (user_id);

-- Scheduled render media: the cleanup cron scans by expiry.
create index if not exists idx_render_media_expires          on public.scheduled_render_media (expires_at);
create index if not exists idx_render_media_user             on public.scheduled_render_media (user_id);

-- Affiliate money paths (FK children, filtered/joined constantly by the dashboard + admin stats).
create index if not exists idx_affiliate_referrals_affiliate   on public.affiliate_referrals (affiliate_id);
create index if not exists idx_affiliate_commissions_affiliate on public.affiliate_commissions (affiliate_id);
create index if not exists idx_affiliate_commissions_referral  on public.affiliate_commissions (referral_id);
create index if not exists idx_affiliates_user                 on public.affiliates (user_id);

-- Support inbox.
create index if not exists idx_support_convos_user           on public.support_conversations (user_id);
create index if not exists idx_support_messages_convo         on public.support_messages (conversation_id, created_at);

-- Brand kit children.
create index if not exists idx_brand_kit_logos_kit           on public.brand_kit_logos (brand_kit_id, position);
create index if not exists idx_brand_kit_fonts_kit           on public.brand_kit_fonts (brand_kit_id);
