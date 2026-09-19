import type { User } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabaseAdmin';
import { createProfile, listProfiles } from './zernio';

// Resolves the Zernio profile a given app user posts/connects under, creating one lazily on first use.
// The mapping lives in public.social_profiles (service-role writes; see supabase/social_profiles.sql),
// so each app user's connected accounts stay isolated in their own Zernio profile.

export async function getOrCreateZernioProfile(user: User): Promise<string> {
  const db = supabaseAdmin();

  const { data: existing, error } = await db
    .from('social_profiles')
    .select('zernio_profile_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw new Error(`social_profiles lookup failed: ${error.message}`);
  if (existing?.zernio_profile_id) return existing.zernio_profile_id;

  // No mapping yet. Resolve a profile idempotently: REUSE a Zernio profile already named for this user
  // (e.g. one created on an earlier attempt before the mapping was written) instead of creating a
  // duplicate — otherwise Zernio rejects with "A profile with this name already exists".
  const name = user.email ?? `user-${user.id.slice(0, 8)}`;
  const profiles = await listProfiles();
  const profileId = profiles.find((p) => p.name === name)?._id ?? (await createProfile(name))._id;

  const { error: upErr } = await db
    .from('social_profiles')
    .upsert({ user_id: user.id, zernio_profile_id: profileId }, { onConflict: 'user_id' });
  if (upErr) throw new Error(`social_profiles write failed: ${upErr.message}`);

  return profileId;
}
