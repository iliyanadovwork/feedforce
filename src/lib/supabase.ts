import { createClient } from '@supabase/supabase-js';

// Placeholder fallbacks keep `next build` from crashing when the env vars are absent
// (prerendering constructs this client at module scope). The REAL values must be set
// in the deployment environment or every Supabase call fails at runtime.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const supabase = createClient(url, key);
