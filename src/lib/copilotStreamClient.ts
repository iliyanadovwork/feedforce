// Client-side reader for the copilot SSE stream (see lib/editorTools/copilotStream.ts for the wire
// format). Parses `event:`/`data:` frames and dispatches them. Reader errors (including an aborted
// fetch → AbortError) propagate to the caller, matching the panels' existing try/catch.

export interface CopilotStreamResult<TFinal> {
  final: TFinal | null;    // the validated structured payload (reply + actions/patch), if the stream completed
  error: string | null;    // an in-band mid-stream error, if one was sent
  replyText: string;       // the prose forwarded via onToken — so a failed/truncated turn can still keep it
}

// Reads the stream to its end, calling onToken for each decoded chunk of reply prose, and RETURNS the
// terminal outcome — returning (rather than firing callbacks for) `final`/`error` so callers get proper
// non-null narrowing. A reader error (incl. an aborted fetch → AbortError) propagates to the caller.
export async function readCopilotStream<TFinal>(
  res: Response,
  onToken: (text: string) => void,
): Promise<CopilotStreamResult<TFinal>> {
  if (!res.body) throw new Error('No response stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: TFinal | null = null;
  let error: string | null = null;
  let replyText = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (event === 'token') { const t = (parsed as { text?: string }).text ?? ''; replyText += t; onToken(t); }
      else if (event === 'final') final = parsed as TFinal;
      else if (event === 'error') error = (parsed as { error?: string }).error ?? 'Copilot failed';
      // 'done' needs no handler — the stream closes right after.
    }
  }
  return { final, error, replyText };
}
