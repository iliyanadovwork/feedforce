import type { RunServices } from './types';
import { geminiChat } from '@/lib/gemini';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getCredentialSecret } from './credentials';

// Builds the server-only RunServices injected into every node run (API routes only). Keeps the engine
// + nodes free of direct env/SDK access — they ask ctx.services for an LLM call, the DB, or a secret.
export function buildRunServices(userId: string): RunServices {
  return {
    llm: (prompt, opts) =>
      geminiChat(
        [
          ...(opts?.system ? [{ role: 'system' as const, content: opts.system }] : []),
          { role: 'user' as const, content: prompt },
        ],
        { json: opts?.json, temperature: opts?.temperature, model: opts?.model, userId },
      ),
    db: supabaseAdmin(),
    getCredentialSecret: (id: string) => getCredentialSecret(userId, id),
  };
}
