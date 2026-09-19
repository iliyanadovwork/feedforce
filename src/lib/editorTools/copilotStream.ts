import { createReplyExtractor } from '@/lib/streamReply';

// Turns a stream of raw model text deltas into a Server-Sent-Events response for the copilot panels:
//   event: token  { text }   — decoded prose of the `reply` field, as it arrives (incremental)
//   event: final  {...}      — the validated structured payload (reply + actions/patch + warnings)
//   event: done   {}         — clean end
//   event: error  { error }  — a mid-stream failure (upstream error or client abort); after HTTP 200
//                              the status can't carry it, so it's delivered in-band
//
// The structured edits are NEVER applied incrementally: `finalize` receives the WHOLE accumulated text
// once the stream ends and parses/zod-validates it exactly as the buffered path did — so a truncated
// or malformed response fails cleanly (an `error` event) rather than half-applying.
export function copilotStreamResponse(
  deltas: AsyncGenerator<string>,
  finalize: (fullText: string) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const extractor = createReplyExtractor();
      let fullText = '';
      try {
        for await (const delta of deltas) {
          fullText += delta;
          const replyDelta = extractor.push(delta);
          if (replyDelta) send('token', { text: replyDelta });
        }
        let payload: Record<string, unknown>;
        try {
          payload = await finalize(fullText);
        } catch {
          // A truncated/malformed model response (SyntaxError/ZodError) — keep the raw internal text
          // off the user's screen; the client keeps any prose that already streamed in.
          send('error', { error: 'The model returned an unreadable response — try again.' });
          return;
        }
        send('final', payload);
        send('done', {});
      } catch (e) {
        // Upstream/mid-stream failure, an idle-timeout abort, or a client disconnect. On an idle abort
        // the client is still connected and would otherwise see a raw "The operation was aborted"; a
        // client-initiated Stop never reads this frame (it already disconnected). enqueue can throw if
        // the client is gone — that's fine, nothing left to tell.
        const aborted = e instanceof Error && e.name === 'AbortError';
        const msg = aborted ? 'The response timed out — please try again.' : (e instanceof Error ? e.message : 'Copilot failed');
        try { send('error', { error: msg }); } catch { /* client gone */ }
      } finally {
        try { controller.close(); } catch { /* already closed/errored */ }
      }
    },
    // If the client disconnects, make sure the delta generator is finalized so its metering `finally`
    // runs (records the spend for tokens already generated) instead of leaking a suspended generator.
    async cancel() {
      await deltas.return(undefined as never).catch(() => {});
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',   // disable proxy buffering so tokens flush immediately
    },
  });
}
