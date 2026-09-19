import type { Metadata } from 'next';
import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BlogShell } from '@/components/blog-shell';
import { NodeFlowDiagram } from '@/components/blog/NodeFlowDiagram';
import { BindingMapMock } from '@/components/blog/BindingMapMock';
import { RepostFlow } from '@/components/repost-flow';
import { getAllPosts, getPost, getRelatedPosts, CLUSTERS, type Figure } from '@/lib/blog';

function FigureBlock({ figure }: { figure: Figure }) {
  switch (figure.type) {
    case 'nodeflow':
      return <NodeFlowDiagram steps={figure.steps} />;
    case 'bindingMap':
      return <BindingMapMock bindings={figure.bindings} />;
    case 'repostFlow':
      return (
        <div className="mx-auto my-10 max-w-md">
          <RepostFlow />
        </div>
      );
  }
}

const ARTICLE_BODY_CLASSES =
  "blog-body space-y-5 text-[0.9875rem] leading-7 text-zinc-300 [&_h2]:mt-12 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-white [&_h3]:mt-8 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-white [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:space-y-1.5 [&_a]:text-white [&_a]:underline [&_a]:underline-offset-2 [&_strong]:text-white [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-400 [&_table]:w-full [&_table]:text-sm [&_th]:border-b [&_th]:border-white/15 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-white [&_td]:border-b [&_td]:border-white/5 [&_td]:px-3 [&_td]:py-2 [&_img]:rounded-lg";

export function generateStaticParams() {
  return getAllPosts().map(post => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    keywords: post.keywords,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: 'article',
      url: `/blog/${post.slug}`,
      title: post.title,
      description: post.description,
      publishedTime: post.date,
      modifiedTime: post.updated ?? post.date,
      // Custom hero overrides the generated card; otherwise the opengraph-image
      // file convention supplies og:image automatically.
      ...(post.image ? { images: [post.image] } : {}),
    },
  };
}

// Article + FAQPage + BreadcrumbList structured data, all derived from the
// frontmatter so every post gets rich-result markup with no per-post work.
function structuredData(post: NonNullable<ReturnType<typeof getPost>>): string {
  const graph: object[] = [
    {
      '@type': 'Article',
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.updated ?? post.date,
      mainEntityOfPage: `https://feedforce.ai/blog/${post.slug}`,
      author: { '@type': 'Organization', name: 'FeedForce', url: 'https://feedforce.ai' },
      publisher: { '@type': 'Organization', name: 'FeedForce', url: 'https://feedforce.ai' },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Blog', item: 'https://feedforce.ai/blog' },
        { '@type': 'ListItem', position: 2, name: post.title, item: `https://feedforce.ai/blog/${post.slug}` },
      ],
    },
  ];
  if (post.faq?.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: post.faq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post || (post.draft && process.env.NODE_ENV !== 'development')) notFound();

  const related = getRelatedPosts(post);

  return (
    <BlogShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData(post) }} />
      <main className="mx-auto w-full max-w-3xl px-2 py-14 sm:px-6">
        <nav className="text-sm text-zinc-500">
          <Link href="/blog" className="hover:text-white">Blog</Link>
          {' / '}
          <span>{CLUSTERS[post.cluster]}</span>
        </nav>

        <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl">
          {post.title}
        </h1>
        <p className="mt-4 text-sm text-zinc-500">
          {post.date}
          {post.updated && ` · Updated ${post.updated}`}
          {' · '}
          {post.readingMinutes} min read
        </p>

        {/* eslint-disable-next-line @next/next/no-img-element -- build-time generated card, fixed size */}
        <img
          src={post.image ?? `/blog/${post.slug}/opengraph-image`}
          alt={post.title}
          className="mt-8 aspect-[1200/630] w-full rounded-2xl border border-white/10 object-cover"
        />

        <article className="mt-10">
          {post.htmlSegments.map((segment, i) => (
            <Fragment key={i}>
              {segment && <div className={ARTICLE_BODY_CLASSES} dangerouslySetInnerHTML={{ __html: segment }} />}
              {post.figures?.[i] && <FigureBlock figure={post.figures[i]} />}
            </Fragment>
          ))}
        </article>

        {post.faq && post.faq.length > 0 && (
          <section className="mt-14 border-t border-white/10 pt-10">
            <h2 className="text-2xl font-semibold tracking-tight text-white">
              Frequently asked questions
            </h2>
            <dl className="mt-6 space-y-6">
              {post.faq.map(({ q, a }) => (
                <div key={q}>
                  <dt className="font-medium text-white">{q}</dt>
                  <dd className="mt-2 leading-7 text-zinc-400">{a}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <aside className="mt-14 rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
          <h2 className="text-xl font-semibold text-white">
            Put your content on autopilot
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-400">
            FeedForce builds automation workflows that turn live signals and news
            into on-brand carousels and reels — designed and published before the
            moment passes.
          </p>
          <Link
            href="/"
            className="mt-5 inline-block rounded-full bg-zinc-100 px-6 py-2.5 font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            Try FeedForce free
          </Link>
        </aside>

        {related.length > 0 && (
          <section className="mt-14">
            <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">
              Keep reading
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              {related.map(r => (
                <Link
                  key={r.slug}
                  href={`/blog/${r.slug}`}
                  className="group rounded-xl border border-white/10 p-4 transition-colors hover:border-white/25"
                >
                  <h3 className="text-sm font-medium text-white group-hover:underline">
                    {r.title}
                  </h3>
                  <p className="mt-2 text-xs text-zinc-500">{r.readingMinutes} min read</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </BlogShell>
  );
}
