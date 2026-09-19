import type { Metadata } from 'next';
import Link from 'next/link';
import { BlogShell } from '@/components/blog-shell';
import { getAllPosts, CLUSTERS, type Cluster, type Post } from '@/lib/blog';

export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Guides on content automation, cross-posting, carousels, and turning news into on-brand social posts — from the team behind FeedForce.',
  alternates: { canonical: '/blog' },
};

const heroSrc = (post: Post) => post.image ?? `/blog/${post.slug}/opengraph-image`;

function PostCard({ post, featured = false }: { post: Post; featured?: boolean }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={`group overflow-hidden rounded-2xl border border-white/10 transition-colors hover:border-white/25 hover:bg-white/[0.03] ${featured ? 'sm:col-span-2 lg:col-span-3' : ''}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- build-time generated card, fixed size */}
      <img
        src={heroSrc(post)}
        alt={post.title}
        loading={featured ? 'eager' : 'lazy'}
        className="aspect-[1200/630] w-full object-cover"
      />
      <div className="p-5">
        <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          {CLUSTERS[post.cluster]}
        </p>
        <h3
          className={`mt-2 font-semibold text-white group-hover:underline ${featured ? 'text-2xl tracking-tight' : ''}`}
        >
          {post.title}
        </h3>
        <p className="mt-2 text-sm leading-6 text-zinc-400">{post.description}</p>
        <p className="mt-3 text-xs text-zinc-500">
          {post.date} · {post.readingMinutes} min read
        </p>
      </div>
    </Link>
  );
}

export default function BlogIndexPage() {
  const posts = getAllPosts();
  // A `featured: true` post is pinned as the hero regardless of date (e.g. a flagship
  // guide); otherwise the newest post takes that slot.
  const featuredIndex = posts.findIndex(p => p.featured);
  const hero = featuredIndex === -1 ? posts[0] : posts[featuredIndex];
  const rest = posts.filter((_, i) => i !== (featuredIndex === -1 ? 0 : featuredIndex));
  const clusters = [...new Set(rest.map(p => p.cluster))] as Cluster[];

  return (
    <BlogShell>
      <main className="mx-auto w-full max-w-6xl px-2 py-16 sm:px-6">
        <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl">
          Content automation, explained.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-400">
          Practical guides on cross-posting, carousels, node automations, and
          turning live signals into on-brand posts — from the team building
          FeedForce.
        </p>

        {hero && (
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <PostCard post={hero} featured />
          </div>
        )}

        {clusters.map(cluster => (
          <section key={cluster} className="mt-14">
            <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">
              {CLUSTERS[cluster]}
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rest
                .filter(p => p.cluster === cluster)
                .map(post => (
                  <PostCard key={post.slug} post={post} />
                ))}
            </div>
          </section>
        ))}
      </main>
    </BlogShell>
  );
}
