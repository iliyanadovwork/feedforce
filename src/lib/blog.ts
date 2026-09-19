import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import { z } from 'zod';

// ── Blog content pipeline (server-only) ───────────────────────────────────────────────────────────
// Posts are markdown files in src/content/blog; the filename (minus .md) is the slug/URL. Frontmatter
// is validated with zod so a malformed post fails the build instead of shipping broken metadata.
// Everything here runs at build time (the blog routes are statically generated).

export const CLUSTERS = {
  'cross-posting': 'Cross-posting',
  carousels: 'Carousels',
  'automation-guides': 'Automation Guides',
  'automation-nodes': 'Automation Nodes',
  'automation-vs': 'Automation Comparisons',
  repurposing: 'Repurposing',
  'news-to-content': 'News to Content',
  scheduling: 'Scheduling & Analytics',
} as const;

export type Cluster = keyof typeof CLUSTERS;

const frontmatterSchema = z.object({
  title: z.string().min(10).max(90),
  description: z.string().min(50).max(180),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  updated: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cluster: z.enum(Object.keys(CLUSTERS) as [Cluster, ...Cluster[]]),
  keywords: z.array(z.string()).min(1).max(10),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
  /** Optional custom hero (path under /public, e.g. /blog/foo.png). Defaults to the generated branded card. */
  image: z.string().optional(),
  /** Pins this post as the blog index's hero, regardless of date. At most one post should set this. */
  featured: z.boolean().optional(),
  /**
   * Ordered illustrations, slotted into the body wherever a `<!--figure-->` marker appears (one marker
   * per entry, in order). Two kinds today:
   *  - nodeflow: a real node-canvas diagram (NodeFlowDiagram) — node types must be real keys in
   *    NODE_DESCRIPTORS, so an illustration can never claim a feature (e.g. an approval-gate node,
   *    an image-URL binding) that doesn't actually exist in the product.
   *  - bindingMap: the Apply Template node's placeholder/element → JSON-path mapping (BindingMapMock).
   *  - repostFlow: the landing page's paste-a-link → fetch → edit → post card (RepostFlow).
   */
  figures: z
    .array(
      z.union([
        z.object({
          type: z.literal('nodeflow'),
          steps: z
            .array(
              z.union([
                z.object({
                  nodeType: z.enum(['trigger', 'http', 'ai', 'code', 'if', 'template', 'element', 'post']),
                  note: z.string().optional(),
                }),
                // Two or more nodes feeding the same next step at once (e.g. multiple sources merging
                // into one Apply Template node) — rendered side by side, not in sequence, so the
                // diagram doesn't misrepresent a parallel join as a linear chain.
                z.object({
                  parallel: z
                    .array(
                      z.object({
                        nodeType: z.enum(['trigger', 'http', 'ai', 'code', 'if', 'template', 'element', 'post']),
                        note: z.string().optional(),
                      }),
                    )
                    .min(2)
                    .max(4),
                }),
              ]),
            )
            .min(2)
            .max(8),
        }),
        z.object({
          type: z.literal('bindingMap'),
          bindings: z
            .array(z.object({ target: z.string(), source: z.string(), kind: z.enum(['text', 'chart']) }))
            .min(1)
            .max(8),
        }),
        z.object({ type: z.literal('repostFlow') }),
      ]),
    )
    .max(6)
    .optional(),
  draft: z.boolean().optional(),
});

export type PostFrontmatter = z.infer<typeof frontmatterSchema>;
export type Figure = NonNullable<PostFrontmatter['figures']>[number];

export interface Post extends PostFrontmatter {
  slug: string;
  /**
   * Article body HTML split on each `<!--figure-->` marker — segments.length is always
   * figures.length + 1 (a trailing empty string if the post ends right after the last marker).
   */
  htmlSegments: string[];
  /** Rough reading time in minutes, floor 1. */
  readingMinutes: number;
}

const FIGURE_MARKER = '<!--figure-->';

const BLOG_DIR = join(process.cwd(), 'src', 'content', 'blog');

marked.use(gfmHeadingId());

function loadPost(filename: string): Post {
  const slug = filename.replace(/\.md$/, '');
  const raw = readFileSync(join(BLOG_DIR, filename), 'utf8');
  const { data, content } = matter(raw);

  const parsed = frontmatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid frontmatter in ${filename}: ${parsed.error.message}`);
  }

  const fullHtml = marked.parse(content, { async: false });
  const words = content.split(/\s+/).length;

  const htmlSegments = parsed.data.figures?.length ? fullHtml.split(FIGURE_MARKER) : [fullHtml];

  return {
    ...parsed.data,
    slug,
    htmlSegments,
    readingMinutes: Math.max(1, Math.round(words / 220)),
  };
}

/** All published posts, newest first. Draft posts are excluded outside development. */
export function getAllPosts(): Post[] {
  const files = readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  return files
    .map(loadPost)
    .filter(p => !p.draft || process.env.NODE_ENV === 'development')
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getPost(slug: string): Post | null {
  try {
    return loadPost(`${slug}.md`);
  } catch {
    return null;
  }
}

/** Other published posts in the same cluster — the automatic internal-linking block. */
export function getRelatedPosts(post: Post, limit = 3): Post[] {
  return getAllPosts()
    .filter(p => p.slug !== post.slug && p.cluster === post.cluster)
    .slice(0, limit);
}
