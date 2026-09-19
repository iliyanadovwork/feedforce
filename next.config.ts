import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Keep client/build-only native deps OUT of the serverless function bundles. transformers.js + ONNX run in
  // the BROWSER for background removal, and sharp is stubbed via the webpack alias below — none are needed at
  // runtime in any API route. Without this, Next's file tracing pulls onnxruntime-node (211 MB) into a
  // function and exceeds Vercel's 250 MB unzipped limit, failing the deploy.
  outputFileTracingExcludes: {
    '*': [
      'node_modules/@huggingface/**',
      'node_modules/onnxruntime-node/**',
      'node_modules/sharp/**',
      'node_modules/@img/**',
    ],
  },
  // transformers.js (background removal) references Node-only deps that must not be pulled into the
  // browser bundle. dev runs with --webpack, so this alias applies (build is webpack by default too).
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = { ...config.resolve.alias, sharp$: false, 'onnxruntime-node$': false };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          // Standard hardening headers (cleanly reversible — no browser-side stickiness like HSTS).
          { key: 'X-Content-Type-Options', value: 'nosniff' },                          // no MIME sniffing
          { key: 'X-Frame-Options',        value: 'SAMEORIGIN' },                       // anti-clickjacking
          { key: 'Referrer-Policy',        value: 'strict-origin-when-cross-origin' },  // limit referrer leak
          // CSP in REPORT-ONLY mode: it BLOCKS NOTHING — it only logs violations to the browser console
          // so you can see what a real (enforcing) policy would break before turning it on. Fully reversible
          // and safe to ship. To enforce later: review the console reports, tighten the directives below
          // (ideally replace 'unsafe-inline'/'unsafe-eval' in script-src with nonces), then rename the header
          // key to 'Content-Security-Policy'. See SECURITY_AUDIT.md §E.
          {
            key: 'Content-Security-Policy-Report-Only',
            value: [
              "default-src 'self'",
              // Next.js ships inline hydration bootstrap + (in dev) eval; report-only so this is observational.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",                  // Tailwind / styled-jsx inject inline styles
              "img-src 'self' data: blob: https:",                 // remote CDN thumbnails + canvas/blob previews
              "media-src 'self' blob: https:",                     // proxied/blob video sources
              "font-src 'self' data:",
              "connect-src 'self' https:",                         // Supabase + AI/proxy fetches
              "worker-src 'self' blob:",                           // transformers.js / canvas workers
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.tikwm.com' },
      { protocol: 'https', hostname: '**.tiktokcdn.com' },
      { protocol: 'https', hostname: '**.tiktokv.com' },
      { protocol: 'https', hostname: '**.tiktokcdn-us.com' },
    ],
  },
};

export default nextConfig;
