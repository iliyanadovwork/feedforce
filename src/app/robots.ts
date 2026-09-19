import type { MetadataRoute } from 'next';

// Served at /robots.txt. Only the marketing homepage is meant for crawlers;
// the API, admin console, headless render routes, and auth flows are not.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/admin', '/render/', '/reset-password'],
      },
    ],
    sitemap: 'https://feedforce.ai/sitemap.xml',
  };
}
