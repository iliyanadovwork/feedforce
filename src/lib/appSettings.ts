import { supabaseAdmin } from './supabaseAdmin';

// Runtime app settings stored in the service-role-only app_settings table (see
// production/supabase/stripe_billing.sql). Server-only — never import from client code.

export type BillingProvider = 'stripe' | 'lemonsqueezy';

const BILLING_PROVIDER_KEY = 'billing_provider';
// New checkouts default to Stripe until the admin flips the switch at /admin.
const DEFAULT_PROVIDER: BillingProvider = 'stripe';

/** Which provider NEW checkouts should use. Existing subscriptions always stay on their own provider. */
export async function getBillingProvider(): Promise<BillingProvider> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('app_settings')
      .select('value')
      .eq('key', BILLING_PROVIDER_KEY)
      .maybeSingle();
    if (error) return DEFAULT_PROVIDER;
    const v = data?.value;
    return v === 'lemonsqueezy' || v === 'stripe' ? v : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

export async function setBillingProvider(provider: BillingProvider): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('app_settings')
    .upsert({ key: BILLING_PROVIDER_KEY, value: provider, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`Failed to save billing provider: ${error.message}`);
}
