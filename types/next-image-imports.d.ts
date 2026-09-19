// CI runs `tsc --noEmit` on a fresh checkout, BEFORE `next build` generates next-env.d.ts (which Next
// gitignores). Without that file TypeScript can't resolve static image imports
// (e.g. `import img from '@/assets/opt/ex1.jpg'` in src/components/posts-marquee.tsx) and fails with
// TS2307. This committed reference pulls in the SAME declarations next-env.d.ts uses
// (next/image-types/global provides `declare module '*.jpg'` etc.), so tsc resolves image imports in every
// environment. It resolves to the same file next-env.d.ts references, so there is no duplicate declaration
// or conflict when next-env.d.ts is also present (local dev, Vercel build).
/// <reference types="next/image-types/global" />
