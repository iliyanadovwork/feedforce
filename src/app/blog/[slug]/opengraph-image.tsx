import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAllPosts, getPost, CLUSTERS, type Cluster } from '@/lib/blog';

// Per-post branded hero card, generated at build time. Doubles as the article's
// og:image (file convention) and as the visible hero/thumbnail (referenced as
// /blog/<slug>/opengraph-image from the index cards and post header).
export const alt = 'FeedForce Blog';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export function generateStaticParams() {
  return getAllPosts().map(post => ({ slug: post.slug }));
}

// Each topic cluster gets its own glow so the blog index reads as a designed
// system rather than a wall of identical cards.
const CLUSTER_GLOW: Record<Cluster, string> = {
  'cross-posting': '124, 58, 237', // violet
  carousels: '16, 185, 129', // emerald
  'automation-guides': '59, 130, 246', // blue
  'automation-nodes': '99, 102, 241', // indigo
  'automation-vs': '168, 85, 247', // purple
  repurposing: '245, 158, 11', // amber
  'news-to-content': '239, 68, 68', // red
  scheduling: '6, 182, 212', // cyan
};

export default async function PostImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPost(slug);
  const font = await readFile(join(process.cwd(), 'public', 'neue-montreal-bold.otf'));

  const glow = post ? CLUSTER_GLOW[post.cluster] : '124, 58, 237';
  const title = post?.title ?? 'FeedForce Blog';
  const cluster = post ? CLUSTERS[post.cluster] : '';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          backgroundColor: '#000',
          backgroundImage: `radial-gradient(ellipse 85% 90% at 85% -10%, rgba(${glow}, 0.55), transparent 60%), radial-gradient(ellipse 60% 50% at 10% 110%, rgba(${glow}, 0.25), transparent 70%)`,
          color: '#fff',
          fontFamily: 'Neue Montreal',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignSelf: 'flex-start',
            fontSize: 26,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: `rgba(${glow}, 1)`,
          }}
        >
          {cluster}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: title.length > 60 ? 58 : 68,
            fontWeight: 700,
            lineHeight: 1.12,
            letterSpacing: '-0.02em',
            maxWidth: 980,
          }}
        >
          {title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 700 }}>FeedForce</div>
          <div style={{ display: 'flex', fontSize: 26, color: 'rgba(255,255,255,0.55)' }}>Blog</div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: 'Neue Montreal', data: font, style: 'normal', weight: 700 }],
    },
  );
}
