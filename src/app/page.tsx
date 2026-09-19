import { cookies } from 'next/headers';
import { HomeClient } from './HomeClient';

// Server entry for '/'. Reads the non-sensitive `ff-auth` presence cookie (set by useAuth when a
// Supabase session exists) so the SSR render already knows whether to paint the loader (returning
// user) or the marketing landing (logged-out visitor / crawler). This is what removes the
// landing-page flash on refresh — the browser can't paint a landing the server never rendered.
//
// SECURITY: the cookie is a UX hint only. It carries no token and grants nothing — a forged
// `ff-auth=1` just makes the loader show for a beat until getSession() finds no session and the
// landing renders. Every real authorization still rides on the Supabase session + per-request JWT
// verification on the API routes. Reading cookies() opts this route into dynamic rendering, which
// is required for a per-user answer and does not affect the (statically described) metadata.
export default async function Page() {
  const store = await cookies();
  const initialAuthHint = store.get('ff-auth')?.value === '1';
  return <HomeClient initialAuthHint={initialAuthHint} />;
}
