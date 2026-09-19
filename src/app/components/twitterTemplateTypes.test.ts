import { describe, it, expect } from 'vitest';
import {
  defaultTwitterTemplateSettings,
  resolveTwitterTemplateSettings,
} from './twitterTemplateTypes';
import type { ReelsCell } from './twitterTemplateTypes';

// This resolver runs on EVERY load of a saved reels template (DB jsonb → render-ready settings). Bugs here
// corrupt or mis-render users' saved work, so pin the merge + legacy-migration behavior.
describe('defaultTwitterTemplateSettings', () => {
  it('returns the documented defaults', () => {
    const d = defaultTwitterTemplateSettings();
    expect(d.captionFontSize).toBe(42);
    expect(d.avatarShape).toBe('circle');
    expect(d.showAvatar).toBe(true);
    expect(d.headerPaddingX).toBe(40);
    expect(d.defaultDisplayName).toBeNull();
  });

  it('returns a fresh object each call (no shared mutable reference)', () => {
    const a = defaultTwitterTemplateSettings();
    const b = defaultTwitterTemplateSettings();
    expect(a).not.toBe(b);          // different references…
    expect(a).toEqual(b);           // …with equal content
  });
});

describe('resolveTwitterTemplateSettings', () => {
  it('returns the defaults for null / undefined (no crash on an empty DB blob)', () => {
    expect(resolveTwitterTemplateSettings(null)).toEqual(defaultTwitterTemplateSettings());
    expect(resolveTwitterTemplateSettings(undefined)).toEqual(defaultTwitterTemplateSettings());
  });

  it('overlays only the provided fields, keeping other defaults intact', () => {
    const out = resolveTwitterTemplateSettings({ captionFontSize: 99, showName: false });
    expect(out.captionFontSize).toBe(99);
    expect(out.showName).toBe(false);
    expect(out.nameColor).toBe(defaultTwitterTemplateSettings().nameColor);  // untouched default preserved
  });

  it('migrates the legacy "bannerCaption" cell type to "banner" in all four cells', () => {
    const legacy = { type: 'bannerCaption' } as unknown as ReelsCell;
    const out = resolveTwitterTemplateSettings({
      cellTop: legacy, cellTop2: legacy, cellBottom: legacy, cellBottom2: legacy,
    });
    expect(out.cellTop).toEqual({ type: 'banner' });
    expect(out.cellTop2).toEqual({ type: 'banner' });
    expect(out.cellBottom).toEqual({ type: 'banner' });
    expect(out.cellBottom2).toEqual({ type: 'banner' });
  });

  it('leaves a non-legacy cell untouched', () => {
    const banner: ReelsCell = { type: 'banner', banner: { /* style blob */ } as ReelsCell['banner'] };
    const out = resolveTwitterTemplateSettings({ cellTop: banner });
    expect(out.cellTop).toEqual(banner);
  });

  it('does not mutate the caller-supplied partial', () => {
    const partial = { captionFontSize: 12 };
    const snapshot = { ...partial };
    resolveTwitterTemplateSettings(partial);
    expect(partial).toEqual(snapshot);
  });
});
