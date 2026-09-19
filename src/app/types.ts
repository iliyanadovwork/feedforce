/** Navigation sections in the sidebar */
export type AppSection = 'template-editor' | 'posts' | 'branding' | 'schedule' | 'analytics' | 'video-reels' | 'rewards' | 'account' | 'automations';

export interface BrandLogo {
  id: string;
  url: string;
  label?: string;
  position: number;
}

export interface BrandFont {
  id: string;
  label: string;   // family name shown in the font picker
  url: string;     // public URL of the uploaded font file
}

/** Brand-kit data passed to canvas templates */
export interface BrandProps {
  logoSrc: string;
  logos: BrandLogo[];
  fonts: BrandFont[];
  displayName: string;
  handle: string;
  colors: string[];   // ordered brand palette (hex strings) — copilot grounding + brand lint
}

export interface Author {
  uniqueId: string;
  nickname: string;
  avatarThumb: string;
}

export interface VideoData {
  id: string;
  title: string;
  cover: string;
  author: Author;
  play: string;
  wmplay: string;
  hdplay: string;
  duration: number;
  size: number;
  images?: string[];
}

export type VideoMode = 'twitter' | 'caption';

// The per-reel text fields editable from the reels rail (url + on-video caption + Instagram description).
export type ReelTextField = 'url' | 'caption' | 'description';

// A finished reel MP4 handed from the Reels canvas to the Post scheduler. `caption` is the on-video
// overlay text; `description` is the intended Instagram post caption (empty falls back to caption via
// reelPostText). See src/lib/reelPostText.ts.
// `stickerEnabled` is present only when the user is enrolled in the creator rewards program; its
// value says whether the FeedForce rewards sticker was baked into this render.
export interface ScheduleReelDraft { blob: Blob; caption: string; description: string; stickerEnabled?: boolean; }

export interface VideoEntry {
  id: string;
  url: string;
  caption: string;
  // Per-reel description. Distinct from `caption` (the on-video overlay text): when a reel is scheduled
  // it becomes the Instagram post caption (Instagram has ONE text field, see reelPostText), and when a
  // reel is downloaded it's written out as a sidecar .txt. Imported from the Content Sheet's description.
  description: string;
  mode: VideoMode;
  data: VideoData | null;
  loading: boolean;
  error: string;
  videoFailed: boolean;
  // local video upload (twitter/caption templates)
  localVideoSrc?: string;
  localVideoName?: string;
  // Durable public URL of the reel's video in the post-videos bucket (Video Reels persistence). Set
  // after an uploaded local file OR a pasted LINK is stored (see storeReel) — so a stored reel loads
  // from our bucket on reload instead of re-fetching the (rot-prone) source. Cleared when the reel's
  // upload or link changes.
  videoUrl?: string;
  // Durable public URL of a poster/thumbnail (post-images bucket), generated at store time. Lets the
  // grid show a frame without instantiating a <video> (loading strategy). Cleared with videoUrl.
  posterUrl?: string;
}
