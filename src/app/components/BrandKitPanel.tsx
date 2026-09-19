'use client';

import { useRef, useState, useCallback } from 'react';
import type { BrandProps } from '../types';
import { AuthForm } from './AuthForm';
import { UploadsGallery } from './UploadsGallery';
import type { SignUpResult } from '../hooks/useAuth';
import { parseFontName } from './customFonts';
import {
  Button, IconButton, TextField, BrandLoader, Badge, Alert, ProgressBar,
  EmptyState, Card, SectionHeader,
} from '@/app/components/ui';
import {
  UploadIcon, PlusIcon, TrashIcon, CheckIcon, CloseIcon, ChevronRightIcon, ImageIcon, PaletteIcon,
} from '@/lib/icons';

const WEIGHT_NAME: Record<number, string> = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular',
  500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};
// Human-readable name for one uploaded style. Prefer the font's own weight name (e.g. "Heavy") over
// the generic CSS one (e.g. "Black") when the filename carried it.
function styleLabel(weight: number, style: 'normal' | 'italic', variable: boolean, name?: string) {
  if (variable) return 'Variable';
  return (name ?? WEIGHT_NAME[weight] ?? String(weight)) + (style === 'italic' ? ' Italic' : '');
}

interface BrandKitPanelProps {
  brand: BrandProps;
  loading?: boolean;
  saving?: boolean;
  uploading?: boolean;
  error?: string | null;
  user: { id: string; email?: string } | null;
  authLoading?: boolean;
  onSignIn: (email: string, password: string) => Promise<string | null>;
  onSignUp: (email: string, password: string) => Promise<SignUpResult>;
  onResetPassword: (email: string) => Promise<string | null>;
  onSave: (displayName: string, handle: string) => Promise<boolean>;
  onUploadLogo: (file: File) => void;
  onDeleteLogo: (id: string) => void;
  onSelectLogo: (url: string) => void;
  onUploadFont: (file: File) => void | Promise<void>;
  onDeleteFont: (id: string) => void;
  onSaveColors: (colors: string[]) => void | Promise<void>;
  onClearError?: () => void;
}

export function BrandKitPanel({
  brand, loading, saving, uploading, error,
  user, authLoading, onSignIn, onSignUp, onResetPassword,
  onSave, onUploadLogo, onDeleteLogo, onSelectLogo, onUploadFont, onDeleteFont, onSaveColors, onClearError,
}: BrandKitPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const fontFileRef = useRef<HTMLInputElement>(null);
  const [fontProgress, setFontProgress] = useState<{ done: number; total: number } | null>(null);
  const [fontMessage, setFontMessage] = useState<string | null>(null);
  const [expandedFonts, setExpandedFonts] = useState<Set<string>>(() => new Set());

  function toggleFontFamily(family: string) {
    setExpandedFonts(prev => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family); else next.add(family);
      return next;
    });
  }
  const [displayName, setDisplayName] = useState(brand.displayName);
  const [handle, setHandle] = useState(brand.handle);
  // Brand palette. Draft state so a color-picker drag previews live; commits (onSaveColors) fire on
  // picker close / add / remove. Resynced via the derive-during-render reset pattern when the kit
  // loads (or saves) after mount — brand.colors only changes identity on load/commit, never mid-drag.
  const [colorsDraft, setColorsDraft] = useState<string[]>(brand.colors);
  const [lastBrandColors, setLastBrandColors] = useState(brand.colors);
  if (brand.colors !== lastBrandColors) {
    setLastBrandColors(brand.colors);
    setColorsDraft(brand.colors);
  }
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pasteMessage, setPasteMessage] = useState<string | null>(null);
  const pasteMessageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local fields when brand loads from Supabase (render-phase adjustment;
  // prev values live in state because refs may not be read during render)
  const [prevBrandName, setPrevBrandName] = useState(brand.displayName);
  if (brand.displayName !== prevBrandName) {
    setPrevBrandName(brand.displayName);
    setDisplayName(brand.displayName);
  }
  const [prevBrandHandle, setPrevBrandHandle] = useState(brand.handle);
  if (brand.handle !== prevBrandHandle) {
    setPrevBrandHandle(brand.handle);
    setHandle(brand.handle);
  }

  const isDirty = displayName !== brand.displayName || handle !== brand.handle;
  const canSave = isDirty && displayName.trim().length > 0 && handle.replace(/^@+/, '').trim().length > 0;

  const handleSave = useCallback(async () => {
    const ok = await onSave(displayName, handle);
    if (ok) {
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    }
  }, [onSave, displayName, handle]);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    onUploadLogo(file);
    e.target.value = '';
  }

  // Identify a font by its variant (family + weight + style) so re-uploads / renamed copies are caught.
  const variantKey = (name: string) => {
    const { family, weight, style } = parseFontName(name);
    return `${family.toLowerCase()}|${weight}|${style}`;
  };

  async function handleFontFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;

    // Skip variants already uploaded (or repeated within this batch).
    const seen = new Set(brand.fonts.map(f => variantKey(f.label)));
    const toUpload: File[] = [];
    let skipped = 0;
    for (const file of files) {
      const key = variantKey(file.name);
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      toUpload.push(file);
    }
    setFontMessage(skipped > 0 ? `Skipped ${skipped} font${skipped > 1 ? 's' : ''} already uploaded.` : null);
    if (!toUpload.length) return;

    // Sequential so the brand kit auto-creates once (no race) when uploading a whole family.
    setFontProgress({ done: 0, total: toUpload.length });
    for (let i = 0; i < toUpload.length; i++) {
      await onUploadFont(toUpload[i]);
      setFontProgress({ done: i + 1, total: toUpload.length });
    }
    setFontProgress(null);
  }

  // Group uploaded font files by family, keeping each style (member) so the family can expand.
  type FontMember = { id: string; label: string; weight: number; style: 'normal' | 'italic'; variable: boolean; weightLabel?: string };
  const fontFamilies = (() => {
    const m = new Map<string, { family: string; members: FontMember[] }>();
    for (const f of brand.fonts) {
      const { family, weight, style, variable, weightLabel } = parseFontName(f.label);
      const member: FontMember = { id: f.id, label: f.label, weight, style, variable, weightLabel };
      const e = m.get(family);
      if (e) e.members.push(member);
      else m.set(family, { family, members: [member] });
    }
    // Order styles lightest→heaviest, normal before italic.
    for (const fam of m.values()) {
      fam.members.sort((a, b) => a.weight - b.weight || (a.style === b.style ? 0 : a.style === 'normal' ? -1 : 1));
    }
    return [...m.values()];
  })();

  async function handlePaste() {
    setPasteMessage(null);
    // navigator.clipboard.read requires a secure context (https or localhost)
    // and a user gesture. The button click satisfies the gesture requirement.
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
      flashPasteMessage('Your browser doesn’t support reading the clipboard');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const ext  = imageType.split('/')[1] || 'png';
        // Fixed name is fine: useBrandKit prefixes the storage path with Date.now().
        const file = new File([blob], `pasted.${ext}`, { type: imageType });
        onUploadLogo(file);
        return;
      }
      flashPasteMessage('No image in clipboard');
    } catch {
      flashPasteMessage('Clipboard permission denied');
    }
  }

  function flashPasteMessage(text: string) {
    setPasteMessage(text);
    if (pasteMessageTimer.current) clearTimeout(pasteMessageTimer.current);
    pasteMessageTimer.current = setTimeout(() => setPasteMessage(null), 3000);
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrandLoader />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center pt-16 gap-10">
        <AuthForm onSignIn={onSignIn} onSignUp={onSignUp} onResetPassword={onResetPassword} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrandLoader />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center pt-10 gap-10">
      {error && (
        <div className="w-full max-w-md flex items-start gap-2">
          <Alert tone="danger" className="flex-1">{error}</Alert>
          <IconButton icon={<CloseIcon size={15} />} label="Dismiss error" variant="ghost" size="sm" onClick={onClearError} />
        </div>
      )}
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <div>
          <h2 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg mb-1">Branding</h2>
          <p className="text-body text-fg-3">Set your identity once, used on every post</p>
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-4">
          <TextField
            label="Display Name"
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="e.g. Your brand"
          />
          {/* The "@" is a fixed prefix so users don't type it themselves; `handle`
              state still stores the @-prefixed value the rest of the app expects. */}
          <TextField
            label="Handle"
            type="text"
            prefix="@"
            value={handle.replace(/^@+/, '')}
            onChange={e => setHandle('@' + e.target.value.replace(/^@+/, ''))}
            placeholder="yourbrand"
          />
        </div>

        <Button
          onClick={handleSave}
          disabled={saving || !canSave}
          loading={saving}
          fullWidth
          variant={saved ? 'secondary' : 'primary'}
          leadingIcon={saved ? <CheckIcon size={14} strokeWidth={2.5} /> : undefined}
        >
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
        </Button>

        {/* Logos — Canva-style justified gallery. Each card uses `aspect-ratio`
            so its height tracks its (flex-grown) width — no inner padding around
            the logo. Different rows get different heights, which is exactly how
            Canva renders justified galleries. */}
        <div className="flex flex-col gap-2">
          <SectionHeader
            title="Uploads"
            actions={
              <div className="flex items-center gap-3">
                {pasteMessage && (
                  <span className="text-caption text-fg-3">{pasteMessage}</span>
                )}
                <Button
                  onClick={handlePaste}
                  disabled={uploading}
                  variant="ghost"
                  size="sm"
                  title="Paste an image from your clipboard"
                  leadingIcon={
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                      <rect x="8" y="2" width="8" height="4" rx="1"/>
                    </svg>
                  }
                >
                  Paste
                </Button>
                <Button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  loading={uploading}
                  variant="ghost"
                  size="sm"
                  title="Upload an image file"
                  leadingIcon={<UploadIcon size={12} />}
                >
                  Upload
                </Button>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
              </div>
            }
          />

          {brand.logos.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line">
              <EmptyState
                icon={<ImageIcon size={20} />}
                bareIcon
                title="No logos yet"
                action={
                  <Button onClick={() => fileRef.current?.click()} variant="secondary" size="sm" leadingIcon={<PlusIcon size={16} />}>
                    Upload your first logo
                  </Button>
                }
              />
            </div>
          ) : (
            <UploadsGallery
              logos={brand.logos}
              activeLogoUrl={brand.logoSrc}
              onSelect={onSelectLogo}
              onDelete={onDeleteLogo}
            />
          )}

          {brand.logos.length > 0 && (
            <p className="text-caption text-fg-3">Click an upload to use it on posts</p>
          )}
        </div>

        {/* Colors — the brand palette. Grounds Build-with-AI edits and the brand-consistency lint. */}
        <div className="flex flex-col gap-2">
          <SectionHeader
            title="Colors"
            actions={colorsDraft.length < 10 ? (
              <Button
                variant="ghost" size="sm" leadingIcon={<PlusIcon size={12} />}
                onClick={() => {
                  const next = [...colorsDraft, '#ffffff'];
                  setColorsDraft(next);
                  void onSaveColors(next);
                }}
              >
                Add
              </Button>
            ) : undefined}
          />
          {colorsDraft.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line">
              <EmptyState
                icon={<PaletteIcon size={20} />}
                bareIcon
                title="No brand colors yet"
                description="Add your palette so templates and AI edits stay on-brand."
                action={
                  <Button
                    variant="secondary" size="sm" leadingIcon={<PlusIcon size={16} />}
                    onClick={() => {
                      const next = [...colorsDraft, '#ffffff'];
                      setColorsDraft(next);
                      void onSaveColors(next);
                    }}
                  >
                    Add your first color
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {colorsDraft.map((c, i) => (
                  <div key={i} className="group relative">
                    <label
                      className="block size-9 cursor-pointer rounded-md border border-line-strong shadow-sm"
                      style={{ background: c }}
                      title={c}
                    >
                      <input
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ffffff'}
                        onChange={e => setColorsDraft(prev => prev.map((p, pi) => (pi === i ? e.target.value : p)))}
                        onBlur={() => void onSaveColors(colorsDraft)}
                        className="invisible absolute size-0"
                      />
                    </label>
                    <button
                      aria-label={`Remove ${c}`}
                      onClick={() => {
                        const next = colorsDraft.filter((_, pi) => pi !== i);
                        setColorsDraft(next);
                        void onSaveColors(next);
                      }}
                      className="absolute -right-1.5 -top-1.5 hidden size-4 place-items-center rounded-full border border-line bg-surface-2 text-[10px] leading-none text-fg-3 hover:text-danger-text group-hover:grid focus-ring"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-caption text-fg-3">Click a swatch to adjust · hover to remove</p>
            </>
          )}
        </div>

        {/* Fonts */}
        <div className="flex flex-col gap-2">
          <SectionHeader
            title="Fonts"
            actions={
              <div className="flex items-center gap-3">
                {fontProgress && (
                  <Badge tone="neutral" className="tabular-nums">Uploading {fontProgress.done}/{fontProgress.total}…</Badge>
                )}
                <Button
                  onClick={() => fontFileRef.current?.click()}
                  disabled={uploading || fontProgress !== null}
                  loading={uploading || fontProgress !== null}
                  variant="ghost"
                  size="sm"
                  title="Upload font files (.ttf, .otf, .woff, .woff2) — select several at once for a whole family"
                  leadingIcon={<UploadIcon size={12} />}
                >
                  Upload
                </Button>
                <input ref={fontFileRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" multiple className="hidden" onChange={handleFontFile} />
              </div>
            }
          />
          {fontProgress && (
            <ProgressBar value={Math.round((fontProgress.done / fontProgress.total) * 100)} tone="neutral" label="Uploading fonts" />
          )}
          {fontMessage && (
            <Alert tone="warning">{fontMessage}</Alert>
          )}

          {brand.fonts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line">
              <EmptyState
                icon={<UploadIcon size={20} />}
                bareIcon
                title="No fonts yet"
                action={
                  <Button onClick={() => fontFileRef.current?.click()} variant="secondary" size="sm">
                    Upload a font (.ttf, .otf, .woff, .woff2)
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {fontFamilies.map(fam => {
                const expanded = expandedFonts.has(fam.family);
                return (
                  <Card key={fam.family} surface={1} padding="none" className="overflow-hidden">
                    {/* Family header — click to expand the styles */}
                    <div className="group flex items-center gap-2 px-2 py-1.5">
                      <button onClick={() => toggleFontFamily(fam.family)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left rounded-md focus-ring">
                        <ChevronRightIcon size={12}
                          className={`text-fg-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
                        <span className="text-body text-fg-2 truncate" style={{ fontFamily: `"${fam.family}", sans-serif` }} title={fam.family}>{fam.family}</span>
                      </button>
                      <Badge tone="neutral" className="tabular-nums shrink-0">{fam.members.length} style{fam.members.length > 1 ? 's' : ''}</Badge>
                      <IconButton
                        onClick={() => fam.members.forEach(mm => onDeleteFont(mm.id))}
                        icon={<TrashIcon size={14} />}
                        label={`Delete ${fam.family}`}
                        title="Delete whole family"
                        variant="danger"
                        size="sm"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      />
                    </div>
                    {/* Individual styles */}
                    {expanded && (
                      <div className="border-t border-line-faint">
                        {fam.members.map(mm => (
                          <div key={mm.id} className="group/style flex items-center gap-2 pl-7 pr-2 py-1 hover:bg-hover">
                            <span className="flex-1 min-w-0 text-caption text-fg-2 truncate"
                              style={{ fontFamily: `"${fam.family}", sans-serif`, fontWeight: mm.weight, fontStyle: mm.style }}
                              title={mm.label}>
                              {styleLabel(mm.weight, mm.style, mm.variable, mm.weightLabel)}
                            </span>
                            <IconButton
                              onClick={() => onDeleteFont(mm.id)}
                              icon={<TrashIcon size={12} />}
                              label={`Delete ${fam.family} ${styleLabel(mm.weight, mm.style, mm.variable, mm.weightLabel)}`}
                              title="Delete this style"
                              variant="danger"
                              size="sm"
                              className="opacity-0 group-hover/style:opacity-100 focus-visible:opacity-100"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                );
              })}
              <p className="text-caption text-fg-3">Pick the family in any font dropdown — the weight buttons &amp; italic toggle select the style.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
