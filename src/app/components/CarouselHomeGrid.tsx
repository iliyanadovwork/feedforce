'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { rowToSlide, type SlideRow } from './templateEditorRows';
import TemplateEditorCanvas, { CAROUSEL_PREVIEW_W, CAROUSEL_PREVIEW_H } from './TemplateEditorCanvas';
import { BrandLoader, HEADER_H } from '@/app/components/ui';
import { PlusIcon, CloseIcon, SearchIcon } from '@/lib/icons';
import { ConfirmDeleteDialog } from './SlidesStrip';
import { NAME_MAX_LENGTH } from '@/lib/ui-constants';
import type { BrandProps } from '../types';

// Canva-style home for the Carousels section: a grid of every post the user has made, each tile showing
// the post's FIRST slide (posts can have many slides — we only visualise page 1). Clicking a tile opens
// that post in the editor. A dedicated fetch (posts + their first slide) so we don't need the editor to
// have loaded every post's slides.
//
// Light organisation on top (deliberately minimal — no tags, no nesting):
//   * a name search in the header — pure client-side filter, the grid already holds every post;
//   * flat folders (carousel_folders) as a chip bar — "All" shows everything, a folder chip filters to
//     its posts, and each tile gets a hover "move to folder" menu. Folders are OPTIONAL at the DB level:
//     the table ships in its own migration (supabase/carousel_folders.sql), so when its fetch errors
//     (table not created yet) the folder UI simply stays hidden and the grid works exactly as before.

interface PostCard { id: string; name: string; slide: SlideRow | null; count: number; folderId: string | null }
interface Folder { id: string; name: string }

// Fixed tile width keeps the scale math simple and gives uniform Canva-like tiles.
const TILE_W = 220;
const THUMB_SCALE = TILE_W / CAROUSEL_PREVIEW_W;
const THUMB_H = Math.round(CAROUSEL_PREVIEW_H * THUMB_SCALE);

// Tiny folder glyph for the per-tile "move to folder" button — same lucide-style stroke recipe as
// @/lib/icons, kept local because nothing else in the app needs a folder icon yet.
const folderGlyph = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
);

export function CarouselHomeGrid({ userId, brand, onOpen, onNew, onRename, onDelete }: {
  userId: string | null;
  brand: BrandProps;
  onOpen: (postId: string) => void;
  onNew: () => void;
  onRename: (postId: string, name: string) => void;
  onDelete: (postId: string) => void;
}) {
  const [cards, setCards] = useState<PostCard[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Header search (case-insensitive name match, applied client-side below).
  const [search, setSearch] = useState('');

  // Folders. null = unavailable: still loading, or the carousel_folders migration hasn't been applied —
  // the fetch below leaves this null on error, which hides the folder bar and the per-tile move button
  // rather than breaking the page.
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);   // null = the "All" chip
  const [folderRenamingId, setFolderRenamingId] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [confirmFolderDelete, setConfirmFolderDelete] = useState<Folder | null>(null);
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null);   // tile whose move-to-folder menu is open

  // Close the move-to-folder menu on any outside press or Escape. The menu and its trigger stop
  // mousedown propagation, so a press that reaches the document is by definition outside — simpler
  // than per-tile ref containment checks with one menu per card.
  useEffect(() => {
    if (!moveMenuId) return;
    const onDown = () => setMoveMenuId(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoveMenuId(null); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [moveMenuId]);

  // Commit an inline rename: optimistic local update (the grid owns its own fetch) + persist upstream.
  function commitRename(id: string) {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    setCards(cs => (cs ?? []).map(c => (c.id === id ? { ...c, name } : c)));
    onRename(id, name);
  }

  // ── Folder CRUD ──────────────────────────────────────────────────────────────────────────────────
  // Unlike posts (persisted via the editor's callbacks, since the editor holds its own post list), the
  // grid owns folders outright — nothing outside this page reads them. Writes are optimistic + silent,
  // matching commitRename above; RLS scopes every statement to the signed-in user.

  async function commitCreateFolder() {
    const name = newFolderName.trim();
    setCreatingFolder(false);
    setNewFolderName('');
    if (!name || !userId) return;
    // Insert first, adopt after — the id is server-generated and the chip needs the real one for
    // filtering/moves, so there's no optimistic placeholder to reconcile.
    const { data } = await supabase
      .from('carousel_folders')
      .insert({ user_id: userId, name, position: folders?.length ?? 0 })
      .select('id, name')
      .single();
    if (!data) return;
    setFolders(fs => [...(fs ?? []), { id: data.id as string, name: data.name as string }]);
    setActiveFolderId(data.id as string);
  }

  function commitFolderRename(id: string) {
    const name = folderRenameValue.trim();
    setFolderRenamingId(null);
    if (!name) return;
    setFolders(fs => (fs ?? []).map(f => (f.id === id ? { ...f, name } : f)));
    void supabase.from('carousel_folders').update({ name }).eq('id', id);
  }

  function deleteFolder(id: string) {
    // The FK is ON DELETE SET NULL, so the server unfiles the folder's posts on its own — mirror the
    // same transition locally (posts → unfiled, selection → All) so the grid is correct immediately,
    // with no refetch and no flash of stale chips/tiles.
    setFolders(fs => (fs ?? []).filter(f => f.id !== id));
    setCards(cs => (cs ?? []).map(c => (c.folderId === id ? { ...c, folderId: null } : c)));
    setActiveFolderId(cur => (cur === id ? null : cur));
    void supabase.from('carousel_folders').delete().eq('id', id);
  }

  function moveToFolder(postId: string, folderId: string | null) {
    setMoveMenuId(null);
    setCards(cs => (cs ?? []).map(c => (c.id === postId ? { ...c, folderId } : c)));
    void supabase.from('template_editor_posts').update({ folder_id: folderId }).eq('id', postId);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId) { setCards([]); return; }
      // Folders load before the empty-posts early return so a user with folders but no posts still
      // sees (and can manage) the bar. Errors leave `folders` null → the folder UI stays hidden.
      const { data: folderRows, error: folderError } = await supabase
        .from('carousel_folders').select('*').eq('user_id', userId).order('position', { ascending: true });
      if (cancelled) return;
      if (!folderError) {
        setFolders(((folderRows ?? []) as Array<Record<string, unknown>>)
          .map(f => ({ id: f.id as string, name: (f.name as string) || 'Untitled folder' })));
      }
      const { data } = await supabase
        .from('template_editor_posts').select('*').eq('user_id', userId).order('position', { ascending: true });
      if (cancelled) return;
      // Show EVERY post — including automation-run snapshots (ephemeral) — so the grid always matches
      // the editor header's post dropdown. Note ephemeral posts are still auto-deleted after
      // publish/cleanup sweeps, so they can disappear from here on their own.
      const postRows = (data ?? []) as Array<Record<string, unknown>>;
      const ids = postRows.map(p => p.id as string);
      if (ids.length === 0) { setCards([]); return; }
      // The grid only needs, per post, the FIRST slide (thumbnail) + total count — but a slide row carries
      // large JSON (image_boxes, free_elements, spans, zone slots). So instead of pulling every slide's
      // full body, do two light queries: (1) id/post_id/position for all slides (tiny columns) → per-post
      // count and the first slide's id; (2) full columns for ONLY those first slides. Same rows render;
      // bytes fetched drop from O(total slides) to O(posts).
      const { data: slideMetaRows } = await supabase
        .from('template_editor_post_slides').select('id, post_id, position')
        .in('post_id', ids).order('position', { ascending: true });
      if (cancelled) return;
      const countByPost = new Map<string, number>();
      const firstSlideIdByPost = new Map<string, string>();
      for (const row of (slideMetaRows ?? []) as Array<{ id: string; post_id: string }>) {
        const pid = row.post_id;
        countByPost.set(pid, (countByPost.get(pid) ?? 0) + 1);
        if (!firstSlideIdByPost.has(pid)) firstSlideIdByPost.set(pid, row.id); // ordered by position asc → first seen is min
      }
      const firstByPost = new Map<string, SlideRow>();
      const firstSlideIds = [...firstSlideIdByPost.values()];
      if (firstSlideIds.length > 0) {
        const { data: firstRows } = await supabase
          .from('template_editor_post_slides').select('*').in('id', firstSlideIds);
        if (cancelled) return;
        for (const row of (firstRows ?? []) as Record<string, unknown>[]) {
          firstByPost.set(row.post_id as string, rowToSlide(row));
        }
      }
      setCards(postRows.map(p => ({
        id: p.id as string,
        name: (p.name as string) || 'Untitled carousel',
        slide: firstByPost.get(p.id as string) ?? null,
        count: countByPost.get(p.id as string) ?? 0,
        // Pre-migration rows come back without the key (select('*') on the old schema) → unfiled.
        folderId: (p.folder_id as string | null) ?? null,
      })));
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Client-side filters: the folder chip narrows first, then the header search.
  const query = search.trim().toLowerCase();
  const visibleCards = (cards ?? []).filter(c =>
    (activeFolderId === null || c.folderId === activeFolderId)
    && (query === '' || c.name.toLowerCase().includes(query)));

  return (
    // Solid bg-page: the section wrapper paints the editor's 96px grid lines (GRID_BG_STYLE); the posts
    // grid is a browsing page, not a canvas, so it covers them.
    <div className="flex h-full flex-col overflow-hidden bg-page">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface-1 px-6" style={{ height: HEADER_H }}>
        <h1 className="text-subheading text-fg">Carousels</h1>
        {cards && <span className="text-caption text-fg-3">{cards.length} {cards.length === 1 ? 'post' : 'posts'}</span>}
        {/* Name search — filters the tiles below as you type. */}
        <div className="ml-auto flex h-8 items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5 transition-colors focus-within:border-line-strong">
          <SearchIcon size={13} className="shrink-0 text-fg-3" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search carousels…"
            aria-label="Search carousels by name"
            className="w-44 bg-transparent text-caption text-fg outline-none placeholder:text-fg-3"
          />
        </div>
      </header>

      {/* Folder bar — flat folders as chips. Hidden entirely while `folders` is null (loading, or the
          carousel_folders migration hasn't been applied yet). Clicking the ACTIVE chip again renames it
          inline — the same second-click-to-edit contract as the tile names below. */}
      {folders !== null && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface-1 px-6 py-2 no-native-scrollbar">
          <button
            onClick={() => setActiveFolderId(null)}
            className={`h-7 shrink-0 rounded-full border px-2.5 text-caption transition-colors focus-ring ${
              activeFolderId === null ? 'border-line-strong bg-active text-fg' : 'border-line text-fg-2 hover:bg-hover hover:text-fg'
            }`}
          >
            All
          </button>
          {folders.map(f => (folderRenamingId === f.id ? (
            <input
              key={f.id}
              autoFocus
              maxLength={NAME_MAX_LENGTH}
              value={folderRenameValue}
              onChange={e => setFolderRenameValue(e.target.value)}
              onFocus={e => e.currentTarget.select()}
              onBlur={() => commitFolderRename(f.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setFolderRenamingId(null);
              }}
              className="h-7 w-36 shrink-0 rounded-full border border-line-strong bg-surface-3 px-2.5 text-caption text-fg outline-none focus-ring"
            />
          ) : (
            // Named group (group/chip): the tiles already use `group` for their own hover reveals, so
            // the chip X needs its own scope to not light up from unrelated hovers.
            <div key={f.id} className="group/chip relative shrink-0">
              <button
                onClick={() => {
                  if (activeFolderId !== f.id) { setActiveFolderId(f.id); return; }
                  setFolderRenameValue(f.name);
                  setFolderRenamingId(f.id);
                }}
                title={activeFolderId === f.id ? 'Rename' : undefined}
                className={`h-7 max-w-48 truncate rounded-full border px-2.5 text-caption transition-colors focus-ring ${
                  activeFolderId === f.id ? 'border-line-strong bg-active text-fg' : 'border-line text-fg-2 hover:bg-hover hover:text-fg'
                }`}
              >
                {f.name}
              </button>
              {/* Hover delete — corner X like the slide cards'. Deleting a folder returns its posts to
                  unfiled (FK ON DELETE SET NULL); the posts themselves are never touched. */}
              <button
                onClick={() => setConfirmFolderDelete(f)}
                aria-label={`Delete folder ${f.name}`}
                className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-surface-3 text-fg opacity-0 shadow-2 ring-1 ring-line-strong transition-opacity hover:bg-danger hover:text-white group-hover/chip:opacity-100 focus-ring"
              >
                <CloseIcon size={9} aria-hidden />
              </button>
            </div>
          )))}
          {creatingFolder ? (
            <input
              autoFocus
              maxLength={NAME_MAX_LENGTH}
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onBlur={() => void commitCreateFolder()}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') { setNewFolderName(''); setCreatingFolder(false); }
              }}
              placeholder="Folder name…"
              className="h-7 w-36 shrink-0 rounded-full border border-line-strong bg-surface-3 px-2.5 text-caption text-fg outline-none placeholder:text-fg-3 focus-ring"
            />
          ) : (
            <button
              onClick={() => setCreatingFolder(true)}
              className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-dashed border-line px-2.5 text-caption text-fg-3 transition-colors hover:border-line-strong hover:text-fg focus-ring"
            >
              <PlusIcon size={12} aria-hidden />
              New folder
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {cards === null ? (
          <div className="grid h-full min-h-[40vh] place-items-center"><BrandLoader /></div>
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-6">
            {/* New carousel tile */}
            <button
              onClick={onNew}
              className="group flex shrink-0 flex-col gap-2 focus-ring"
              style={{ width: TILE_W }}
            >
              <div
                className="grid place-items-center border border-dashed border-line bg-surface-1 text-fg-3 transition-colors group-hover:border-line-strong group-hover:text-fg"
                style={{ width: TILE_W, height: THUMB_H }}
              >
                <div className="flex flex-col items-center gap-2">
                  <PlusIcon size={22} aria-hidden />
                  <span className="text-caption">New carousel</span>
                </div>
              </div>
              <span className="text-caption text-transparent">.</span>
            </button>

            {visibleCards.map(card => (
              <div key={card.id} className="group flex shrink-0 flex-col gap-2" style={{ width: TILE_W }}>
                <div className="relative" style={{ width: TILE_W, height: THUMB_H }}>
                  <button
                    onClick={() => onOpen(card.id)}
                    aria-label={`Open ${card.name}`}
                    className="block h-full w-full overflow-hidden bg-surface-2 text-left ring-1 ring-line transition-shadow focus-ring group-hover:ring-line-strong group-hover:shadow-2"
                  >
                    {card.slide ? (
                      // Static, non-interactive render of the first slide, scaled to fit the tile.
                      <div
                        className="pointer-events-none origin-top-left"
                        style={{ width: CAROUSEL_PREVIEW_W, height: CAROUSEL_PREVIEW_H, transform: `scale(${THUMB_SCALE})` }}
                      >
                        <TemplateEditorCanvas
                          imageSrc=""
                          headline={card.slide.headline}
                          subheadline={card.slide.subheadline}
                          settings={card.slide.settings}
                          brandLogoSrc={brand.logoSrc || undefined}
                          rectMode
                          staticMode
                          cleanView
                        />
                      </div>
                    ) : (
                      <div className="grid h-full place-items-center text-caption text-fg-4">Empty</div>
                    )}
                    {/* Multi-slide indicator (Canva-style page count). */}
                    {card.count > 1 && (
                      <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                        {card.count} pages
                      </span>
                    )}
                  </button>
                  {/* Hover delete — opens the same confirmation card as the header dropdown. */}
                  <button
                    onClick={() => setConfirmDelete({ id: card.id, name: card.name })}
                    aria-label={`Delete ${card.name}`}
                    className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-danger group-hover:opacity-100 focus-ring"
                  >
                    <CloseIcon size={12} aria-hidden />
                  </button>
                  {/* Hover move-to-folder — sits under the delete X, opens a small in-tile menu. Only
                      rendered once at least one folder exists (with none there is nowhere to move to),
                      and never when folders are unavailable. */}
                  {folders !== null && folders.length > 0 && (
                    <>
                      <button
                        // Stop mousedown so the document-level outside-press closer doesn't close the
                        // menu first and make this click instantly reopen it.
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => setMoveMenuId(open => (open === card.id ? null : card.id))}
                        aria-label={`Move ${card.name} to folder`}
                        aria-expanded={moveMenuId === card.id}
                        className="absolute right-1.5 top-9 grid size-6 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/75 group-hover:opacity-100 focus-ring"
                      >
                        {folderGlyph}
                      </button>
                      {moveMenuId === card.id && (
                        <div
                          onMouseDown={e => e.stopPropagation()}
                          className="absolute right-1.5 top-16 z-20 max-h-56 w-44 overflow-y-auto rounded-xl border border-line bg-surface-2 py-1 shadow-3"
                        >
                          <button
                            onClick={() => moveToFolder(card.id, null)}
                            className={`w-full truncate px-3 py-2 text-left text-caption transition-colors focus-ring ${
                              card.folderId === null ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'
                            }`}
                          >
                            Unfiled
                          </button>
                          {folders.map(f => (
                            <button
                              key={f.id}
                              onClick={() => moveToFolder(card.id, f.id)}
                              className={`w-full truncate px-3 py-2 text-left text-caption transition-colors focus-ring ${
                                card.folderId === f.id ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'
                              }`}
                            >
                              {f.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {/* Name — click to rename inline (Enter/blur commits, Escape cancels). */}
                {renamingId === card.id ? (
                  <input
                    autoFocus
                    maxLength={NAME_MAX_LENGTH}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onFocus={e => e.currentTarget.select()}
                    onBlur={() => commitRename(card.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="w-full rounded-md bg-surface-3 px-1.5 py-0.5 text-caption text-fg outline-none focus-ring"
                  />
                ) : (
                  <button
                    onClick={() => { setRenameValue(card.name); setRenamingId(card.id); }}
                    title="Rename"
                    className="truncate rounded-sm text-left text-caption text-fg-2 hover:text-fg focus-ring"
                  >
                    {card.name}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDeleteDialog
          slideName={confirmDelete.name}
          kind="post"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            setCards(cs => (cs ?? []).filter(c => c.id !== confirmDelete.id));
            onDelete(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}

      {confirmFolderDelete && (
        <ConfirmDeleteDialog
          slideName={confirmFolderDelete.name}
          kind="folder"
          onCancel={() => setConfirmFolderDelete(null)}
          onConfirm={() => {
            deleteFolder(confirmFolderDelete.id);
            setConfirmFolderDelete(null);
          }}
        />
      )}
    </div>
  );
}
