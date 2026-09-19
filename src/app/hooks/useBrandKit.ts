'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { requestUpgrade, upgradeReasonForDbError } from '@/lib/upgradePrompt';
import type { BrandProps, BrandLogo, BrandFont } from '../types';
import { setCustomFonts } from '../components/customFonts';

const EMPTY_BRAND: BrandProps = {
  logoSrc: '',
  logos: [],
  fonts: [],
  displayName: '',
  handle: '',
  colors: [],
};

const MAX_BRAND_COLORS = 10;

function toDbHandle(h: string) { return h.replace(/^@+/, ''); }
function toDisplayHandle(h: string) { return h.startsWith('@') ? h : `@${h}`; }

export function useBrandKit(userId: string | null) {
  const [brand, setBrandState] = useState<BrandProps>(EMPTY_BRAND);
  const setBrand = useCallback((updater: BrandProps | ((prev: BrandProps) => BrandProps)) => {
    setBrandState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      brandRef.current = next;
      return next;
    });
  }, []);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const brandKitIdRef = useRef<string | null>(null);
  const brandRef = useRef<BrandProps>(EMPTY_BRAND);

  useEffect(() => {
    if (!userId) {
      setBrand(EMPTY_BRAND);
      brandKitIdRef.current = null;
      return;
    }

    async function load() {
      setLoading(true);

      const { data: kit, error: fetchErr } = await supabase
        .from('brand_kit')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (fetchErr) {
        setError(`DB error: ${fetchErr.message}`);
        setLoading(false);
        return;
      }

      if (!kit) {
        setLoading(false);
        return;
      }

      brandKitIdRef.current = kit.id;

      const { data: logoRows } = await supabase
        .from('brand_kit_logos')
        .select('*')
        .eq('brand_kit_id', kit.id)
        .order('position');

      const logos: BrandLogo[] = (logoRows ?? []).map(l => ({
        id: l.id,
        url: l.url,
        label: l.label ?? undefined,
        position: l.position,
      }));

      const { data: fontRows } = await supabase
        .from('brand_kit_fonts')
        .select('*')
        .eq('brand_kit_id', kit.id)
        .order('created_at');

      const fonts: BrandFont[] = (fontRows ?? []).map(f => ({ id: f.id, label: f.label, url: f.url }));

      // Restore the previously selected logo if it still exists; else default to the first.
      const savedLogo = localStorage.getItem(`de:selected-logo:${userId}`);
      const logoSrc = (savedLogo && logos.some(l => l.url === savedLogo))
        ? savedLogo
        : (logos[0]?.url ?? '');

      setBrand({
        displayName: kit.display_name ?? '',
        handle: kit.handle ? toDisplayHandle(kit.handle) : '',
        logos,
        fonts,
        logoSrc,
        colors: (Array.isArray(kit.colors) ? kit.colors : [])
          .filter((c: unknown): c is string => typeof c === 'string')
          .slice(0, MAX_BRAND_COLORS),
      });

      setLoading(false);
    }

    load();
  }, [userId]);

  const save = useCallback(async (displayName: string, handle: string): Promise<boolean> => {
    if (!userId) return false;
    setSaving(true);
    const dbHandle = toDbHandle(handle);
    const id = brandKitIdRef.current;
    let ok = false;

    if (!id) {
      const { data, error: insertErr } = await supabase
        .from('brand_kit')
        .insert({ display_name: displayName, handle: dbHandle, user_id: userId })
        .select()
        .single();

      if (insertErr) {
        setError(`Save error: ${insertErr.message}`);
      } else {
        brandKitIdRef.current = data.id;
        setBrand(prev => ({ ...prev, displayName, handle: toDisplayHandle(data.handle) }));
        ok = true;
      }
    } else {
      const { error: updateErr } = await supabase
        .from('brand_kit')
        .update({ display_name: displayName, handle: dbHandle })
        .eq('id', id);

      if (updateErr) {
        setError(`Save error: ${updateErr.message}`);
      } else {
        setBrand(prev => ({ ...prev, displayName, handle: toDisplayHandle(dbHandle) }));
        ok = true;
      }
    }
    setSaving(false);
    return ok;
  }, [userId]);

  const uploadLogo = useCallback(async (file: File) => {
    if (!userId) return;
    setUploading(true);

    // Auto-create record if first action before saving
    if (!brandKitIdRef.current) {
      const { data, error: insertErr } = await supabase
        .from('brand_kit')
        .insert({ display_name: 'My Brand', handle: 'handle', user_id: userId })
        .select()
        .single();

      if (insertErr) {
        setError(`Error: ${insertErr.message}`);
        setUploading(false);
        return;
      }
      brandKitIdRef.current = data.id;
      setBrand(prev => ({
        ...prev,
        displayName: prev.displayName || data.display_name,
        handle: prev.handle || toDisplayHandle(data.handle),
      }));
    }

    const id = brandKitIdRef.current!;
    // Use userId as folder so storage RLS policy matches auth.uid()
    const path = `${userId}/${Date.now()}_${file.name}`;

    const { error: uploadErr } = await supabase.storage
      .from('brand-kit-logos')
      .upload(path, file);

    if (uploadErr) {
      // Free-plan storage quota (DB trigger, supabase/free_tier.sql) → upgrade prompt, not an error.
      const upgrade = upgradeReasonForDbError(uploadErr.message);
      if (upgrade) { requestUpgrade(upgrade); setUploading(false); return; }
      setError(`Upload error: ${uploadErr.message}`);
      setUploading(false);
      return;
    }

    const { data: { publicUrl } } = supabase.storage
      .from('brand-kit-logos')
      .getPublicUrl(path);

    const { data: logo, error: logoInsertErr } = await supabase
      .from('brand_kit_logos')
      // Append after existing logos. A hardcoded 0 made every logo collide on position, so the gallery
      // order was non-deterministic across refreshes (Postgres has no stable tiebreak for equal positions).
      .insert({ brand_kit_id: id, url: publicUrl, position: brandRef.current.logos.length })
      .select()
      .single();

    if (logoInsertErr) {
      setError(`Logo save error: ${logoInsertErr.message}`);
    } else if (logo) {
      const newLogo: BrandLogo = { id: logo.id, url: publicUrl, position: logo.position };
      setBrand(prev => ({
        ...prev,
        logos: [...prev.logos, newLogo],
        logoSrc: prev.logoSrc || publicUrl,
      }));
    }

    setUploading(false);
  }, [userId]);

  const deleteLogo = useCallback(async (logoId: string) => {
    const logo = brandRef.current.logos.find(l => l.id === logoId);
    if (!logo) return;

    // Optimistic UI update
    setBrand(prev => {
      const logos = prev.logos.filter(l => l.id !== logoId);
      const logoSrc = prev.logoSrc === logo.url ? (logos[0]?.url ?? '') : prev.logoSrc;
      return { ...prev, logos, logoSrc };
    });

    // Delete DB row
    const { error: dbErr } = await supabase
      .from('brand_kit_logos')
      .delete()
      .eq('id', logoId);

    if (dbErr) {
      setError(`Delete error: ${dbErr.message}`);
      // Revert optimistic update
      setBrand(prev => ({
        ...prev,
        logos: [...prev.logos, logo].sort((a, b) => a.position - b.position),
        logoSrc: prev.logoSrc || logo.url,
      }));
      return;
    }

    // Delete from storage — path is everything after /brand-kit-logos/
    const storagePath = logo.url.split('/brand-kit-logos/')[1];
    if (storagePath) {
      const { error: storageErr } = await supabase.storage
        .from('brand-kit-logos')
        .remove([storagePath]);
      if (storageErr) console.error('[BrandKit] storage delete error:', storageErr);
    }
  }, []);

  const selectLogo = useCallback((url: string) => {
    setBrand(prev => ({ ...prev, logoSrc: url }));
    if (userId) localStorage.setItem(`de:selected-logo:${userId}`, url);
  }, [userId]);

  const uploadFont = useCallback(async (file: File) => {
    if (!userId) return;
    setUploading(true);

    // Auto-create the brand kit on first action, like uploadLogo
    if (!brandKitIdRef.current) {
      const { data, error: insertErr } = await supabase
        .from('brand_kit')
        .insert({ display_name: 'My Brand', handle: 'handle', user_id: userId })
        .select()
        .single();
      if (insertErr) { setError(`Upload error: ${insertErr.message}`); setUploading(false); return; }
      brandKitIdRef.current = data.id;
      setBrand(prev => ({ ...prev, displayName: prev.displayName || data.display_name, handle: prev.handle || toDisplayHandle(data.handle) }));
    }

    const id = brandKitIdRef.current!;
    const path = `${userId}/${Date.now()}_${file.name}`;

    const { error: uploadErr } = await supabase.storage.from('brand-kit-fonts').upload(path, file);
    if (uploadErr) {
      const upgrade = upgradeReasonForDbError(uploadErr.message);
      if (upgrade) { requestUpgrade(upgrade); setUploading(false); return; }
      setError(`Upload error: ${uploadErr.message}`); setUploading(false); return;
    }

    const { data: { publicUrl } } = supabase.storage.from('brand-kit-fonts').getPublicUrl(path);
    const label = file.name.replace(/\.[^.]+$/, '').trim() || 'Custom Font';

    const { data: row, error: insertErr } = await supabase
      .from('brand_kit_fonts')
      .insert({ brand_kit_id: id, label, url: publicUrl })
      .select()
      .single();

    if (insertErr) {
      setError(`Font save error: ${insertErr.message}`);
    } else if (row) {
      setBrand(prev => ({ ...prev, fonts: [...prev.fonts, { id: row.id, label, url: publicUrl }] }));
    }
    setUploading(false);
  }, [userId]);

  const deleteFont = useCallback(async (fontId: string) => {
    const font = brandRef.current.fonts.find(f => f.id === fontId);
    if (!font) return;
    setBrand(prev => ({ ...prev, fonts: prev.fonts.filter(f => f.id !== fontId) }));

    const { error: dbErr } = await supabase.from('brand_kit_fonts').delete().eq('id', fontId);
    if (dbErr) {
      setError(`Delete error: ${dbErr.message}`);
      setBrand(prev => ({ ...prev, fonts: [...prev.fonts, font] }));
      return;
    }
    const storagePath = font.url.split('/brand-kit-fonts/')[1];
    if (storagePath) {
      const { error: storageErr } = await supabase.storage.from('brand-kit-fonts').remove([storagePath]);
      if (storageErr) console.error('[BrandKit] font storage delete error:', storageErr);
    }
  }, []);

  // Persist the brand palette (optimistic; reverts on error). Auto-creates the kit row like
  // uploadLogo so setting colors works before the identity has ever been saved.
  const saveColors = useCallback(async (colors: string[]) => {
    if (!userId) return;
    const cleaned = colors
      .filter(c => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim()))
      .map(c => c.trim().toLowerCase())
      .slice(0, MAX_BRAND_COLORS);
    const previous = brandRef.current.colors;
    setBrand(prev => ({ ...prev, colors: cleaned }));

    if (!brandKitIdRef.current) {
      const { data, error: insertErr } = await supabase
        .from('brand_kit')
        .insert({ display_name: 'My Brand', handle: 'handle', user_id: userId, colors: cleaned })
        .select()
        .single();
      if (insertErr) {
        setError(`Save error: ${insertErr.message}`);
        setBrand(prev => ({ ...prev, colors: previous }));
        return;
      }
      brandKitIdRef.current = data.id;
      setBrand(prev => ({ ...prev, displayName: prev.displayName || data.display_name, handle: prev.handle || toDisplayHandle(data.handle) }));
      return;
    }

    const { error: updateErr } = await supabase
      .from('brand_kit')
      .update({ colors: cleaned })
      .eq('id', brandKitIdRef.current);
    if (updateErr) {
      setError(`Save error: ${updateErr.message}`);
      setBrand(prev => ({ ...prev, colors: previous }));
    }
  }, [userId]);

  // Keep the global custom-font registry (used by the editor canvas + font pickers) in sync.
  useEffect(() => { setCustomFonts(brand.fonts); }, [brand.fonts]);

  return { brand, setBrand, saving, uploading, loading, error, setError, save, uploadLogo, deleteLogo, selectLogo, uploadFont, deleteFont, saveColors };
}
