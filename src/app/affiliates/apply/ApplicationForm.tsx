'use client';

import { useState } from 'react';
import { Alert, Button, Textarea, TextField } from '@/app/components/ui';

// Step 2 of /affiliates/apply — the applicant's social/audience details. Submits to
// POST /api/affiliates/application (src/app/api/affiliates/application/route.ts), which enforces the
// same "name + (website or a handle)" rule server-side.

export interface ApplicationInput {
  name: string;
  website: string;
  instagramHandle: string;
  tiktokHandle: string;
  youtubeHandle: string;
  twitterHandle: string;
  audienceSize: string;
  promotionPlan: string;
}

export function ApplicationForm({ onSubmit }: { onSubmit: (data: ApplicationInput) => Promise<string | null> }) {
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [instagramHandle, setInstagramHandle] = useState('');
  const [tiktokHandle, setTiktokHandle] = useState('');
  const [youtubeHandle, setYoutubeHandle] = useState('');
  const [twitterHandle, setTwitterHandle] = useState('');
  const [audienceSize, setAudienceSize] = useState('');
  const [promotionPlan, setPromotionPlan] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasContact = Boolean(website.trim() || instagramHandle.trim() || tiktokHandle.trim() || youtubeHandle.trim() || twitterHandle.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!hasContact) { setError("Add your website or at least one social handle."); return; }
    setSubmitting(true);
    setError(null);
    const err = await onSubmit({
      name: name.trim(), website: website.trim(),
      instagramHandle: instagramHandle.trim(), tiktokHandle: tiktokHandle.trim(),
      youtubeHandle: youtubeHandle.trim(), twitterHandle: twitterHandle.trim(),
      audienceSize: audienceSize.trim(), promotionPlan: promotionPlan.trim(),
    });
    setSubmitting(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-lg flex flex-col gap-4">
      <div className="text-center">
        <h2 className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-fg">Tell us about you</h2>
        <p className="text-body text-fg-3 mt-1">A couple of details so we can review your application.</p>
      </div>

      <TextField label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" required />
      <TextField label="Website" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://" optional />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Instagram" value={instagramHandle} onChange={e => setInstagramHandle(e.target.value)} placeholder="@handle" optional />
        <TextField label="TikTok" value={tiktokHandle} onChange={e => setTiktokHandle(e.target.value)} placeholder="@handle" optional />
        <TextField label="YouTube" value={youtubeHandle} onChange={e => setYoutubeHandle(e.target.value)} placeholder="@handle" optional />
        <TextField label="X / Twitter" value={twitterHandle} onChange={e => setTwitterHandle(e.target.value)} placeholder="@handle" optional />
      </div>

      <TextField label="Audience size" value={audienceSize} onChange={e => setAudienceSize(e.target.value)} placeholder="e.g. 40k followers" optional />
      <Textarea label="How will you promote FeedForce? (optional)" value={promotionPlan} onChange={e => setPromotionPlan(e.target.value)} placeholder="Reviews, tutorials, a link in bio…" />

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" variant="primary" fullWidth loading={submitting} disabled={submitting}>
        Submit application
      </Button>
    </form>
  );
}
