import type { MetadataRoute } from 'next';
import { getAllPosts } from '@/lib/blog';

// Served at /sitemap.xml. Blog posts are included automatically; add other new
// public marketing pages here as they ship — app/admin/reset-password routes
// stay out (they're noindexed + robots-disallowed).
export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();
  return [
    {
      url: 'https://feedforce.ai/',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    { url: 'https://feedforce.ai/blog', changeFrequency: 'daily', priority: 0.8 },
    ...posts.map(post => ({
      url: `https://feedforce.ai/blog/${post.slug}`,
      lastModified: new Date(post.updated ?? post.date),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    { url: 'https://feedforce.ai/privacy', changeFrequency: 'yearly' as const, priority: 0.2 },
    { url: 'https://feedforce.ai/terms', changeFrequency: 'yearly' as const, priority: 0.2 },
    { url: 'https://feedforce.ai/refunds', changeFrequency: 'yearly' as const, priority: 0.2 },
  ];
}
