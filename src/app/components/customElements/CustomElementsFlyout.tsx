'use client';

import { useEffect, useState } from 'react';
import { Modal, Button, TextField, Textarea } from '@/app/components/ui';
import { useCustomElements } from '@/app/hooks/useCustomElements';
import { usePublicElements, toNewCustomElement } from '@/app/hooks/usePublicElements';
import type { ElementRenderTheme } from '@/lib/customElements/runtime';
import { ElementPreview } from './ElementPreview';
import type { ElementInsert } from './ElementBuilderPanel';

// The "Custom elements" rail flyout: previews of the user's saved elements (click to insert), plus a "+"
// tile to create a new one — either with AI (opens the Build-with-AI chat) or by pasting a draw-function.
export function CustomElementsFlyout({ userId, theme, onInsert, onBuildWithAI }: {
  userId: string | null;
  theme: ElementRenderTheme;
  onInsert: (el: ElementInsert) => void;
  onBuildWithAI: () => void;
}) {
  const { elements, saveElement, removeElement } = useCustomElements(userId);
  const { elements: libraryElements, loading: libraryLoading, ensureLoaded: ensureLibraryLoaded } = usePublicElements();
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<'menu' | 'paste'>('menu');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [w, setW] = useState(720);
  const [h, setH] = useState(460);
  const [addingId, setAddingId] = useState<string | null>(null);

  function reset() { setCreating(false); setMode('menu'); setName(''); setCode(''); setW(720); setH(460); }

  async function savePasted() {
    const body = code.trim();
    if (!body) return;
    const nm = name.trim() || 'Element';
    const size = { w, h, aspect: w / Math.max(1, h) };
    const rec = await saveElement({ name: nm, description: '', code: body, inputSchema: [], defaultData: null, size });
    onInsert({ elementId: rec?.id ?? `local_${Date.now()}`, name: nm, code: body, inputSchema: [], data: null, size });
    reset();
  }

  async function addFromLibrary(el: (typeof libraryElements)[number]) {
    setAddingId(el.id);
    const rec = await saveElement(toNewCustomElement(el));
    setAddingId(null);
    if (!rec) return;
    onInsert({ elementId: rec.id, name: rec.name, code: rec.code, inputSchema: rec.inputSchema, data: rec.defaultData, size: rec.size });
    reset();
  }

  // The library section under "your elements" is always visible, so load it eagerly (once).
  useEffect(() => { void ensureLibraryLoaded(); }, [ensureLibraryLoaded]);

  const plusTile = (
    <button onClick={() => { setMode('menu'); setCreating(true); }} title="New element"
      className="grid aspect-square place-items-center rounded-md border border-dashed border-line-strong text-fg-3 transition-colors hover:border-fg-3 hover:text-fg focus-ring">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
    </button>
  );

  return (
    <div className="w-[232px] px-1 pb-1">
      <div className="grid grid-cols-2 gap-1.5">
        {elements.map(el => (
          <div key={el.id} className="group relative flex aspect-square flex-col items-center justify-center gap-1 rounded-md border border-line p-1 transition-colors hover:border-line-strong">
            <button title={`Insert ${el.name}`}
              onClick={() => onInsert({ elementId: el.id, name: el.name, code: el.code, inputSchema: el.inputSchema, data: el.defaultData, size: el.size })}
              className="flex min-h-0 flex-1 items-center justify-center overflow-hidden focus-ring">
              <ElementPreview code={el.code} data={el.defaultData} size={el.size} theme={theme} displayW={90} className="rounded bg-surface-2" />
            </button>
            <span className="w-full truncate text-center text-[10px] text-fg-3">{el.name}</span>
            <button aria-label={`Delete ${el.name}`} onClick={() => void removeElement(el.id)}
              className="absolute right-1 top-1 hidden size-5 place-items-center rounded bg-surface-overlay text-fg-3 hover:text-danger-text group-hover:grid">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        ))}
        {plusTile}
      </div>
      {elements.length === 0 && (
        <p className="mt-2 px-1 text-center text-caption text-fg-3">No elements yet — create one with AI or paste code.</p>
      )}

      <div className="mt-3 flex flex-col gap-1.5">
        <span className="px-1 text-caption text-fg-3">Library</span>
        <div className="grid max-h-[260px] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5">
          {libraryLoading ? (
            <p className="col-span-2 px-1 py-3 text-center text-caption text-fg-3">Loading…</p>
          ) : libraryElements.length === 0 ? (
            <p className="col-span-2 px-1 py-3 text-center text-caption text-fg-3">Nothing here yet.</p>
          ) : libraryElements.map(el => (
            <div key={el.id} className="flex aspect-square flex-col items-center justify-between rounded-md border border-line p-1.5">
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                <ElementPreview code={el.code} data={el.defaultData} size={el.size} theme={theme} displayW={90} className="rounded bg-surface-2" />
              </div>
              <span className="w-full truncate text-center text-[10px] text-fg-3">{el.name}</span>
              <Button variant="secondary" size="sm" className="w-full" disabled={addingId === el.id} onClick={() => void addFromLibrary(el)}>
                {addingId === el.id ? 'Adding…' : 'Add'}
              </Button>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={creating} onClose={reset} size="sm" variant="auth" title="New element"
        footer={mode === 'paste' ? (
          <>
            <Button variant="ghost" onClick={() => setMode('menu')}>Back</Button>
            <Button variant="primary" onClick={() => void savePasted()} disabled={!code.trim()}>Add element</Button>
          </>
        ) : undefined}
      >
        {mode === 'menu' ? (
          <div className="flex flex-col gap-2 py-1">
            <button onClick={() => { reset(); onBuildWithAI(); }}
              className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-3 text-left text-body text-fg transition-colors hover:bg-hover hover:border-line-strong focus-ring">
              <span className="brightness-0 invert">✨</span>
              <span><span className="block font-medium">Build with AI</span><span className="block text-caption text-fg-3">Describe a chart, table, candlestick…</span></span>
            </button>
            <button onClick={() => setMode('paste')}
              className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-3 text-left text-body text-fg transition-colors hover:bg-hover hover:border-line-strong focus-ring">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></svg>
              <span><span className="block font-medium">Paste code</span><span className="block text-caption text-fg-3">Body of <code>(ctx, props) =&gt; void</code></span></span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-1">
            <TextField label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="My chart" />
            <div className="flex gap-2">
              <TextField label="Width" type="number" value={String(w)} onChange={e => setW(parseInt(e.target.value) || 720)} />
              <TextField label="Height" type="number" value={String(h)} onChange={e => setH(parseInt(e.target.value) || 460)} />
            </div>
            <Textarea label="Code" rows={8} value={code} onChange={e => setCode(e.target.value)} className="font-mono text-[12px]"
              placeholder="const { width: w, height: h, progress, theme } = props;\n// draw relative to w/h, animate with progress (0→1)…" />
            {code.trim() && (
              <div className="flex justify-center"><ElementPreview code={code} data={null} size={{ w, h }} theme={theme} displayW={200} animate /></div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
