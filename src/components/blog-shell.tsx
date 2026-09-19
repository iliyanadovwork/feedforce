import Link from 'next/link';
import { Logo } from '@/components/logo';

// Shared shell for the blog (/blog, /blog/[slug]). Same standalone dark register as LegalPage:
// server-rendered, free of app tokens, with the primary CTA linking back to the landing where
// the signup overlay lives.

export function BlogShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black text-zinc-200">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-black">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-2 sm:px-6">
          <Link href="/" aria-label="FeedForce home">
            <Logo className="h-6 w-auto" />
          </Link>
          <nav className="flex items-center gap-5 text-[0.875rem] text-zinc-400">
            <Link href="/blog" className="hover:text-white">
              Blog
            </Link>
            <Link
              href="/"
              className="rounded-full bg-zinc-100 px-5 py-2 font-medium text-zinc-900 transition-colors hover:bg-white"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      {children}

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-2 py-6 sm:flex-row sm:px-6">
          <p className="text-sm text-zinc-500">
            &copy; {new Date().getFullYear()} FeedForce, All rights reserved
          </p>
          <nav className="flex gap-5 text-sm text-zinc-500">
            <Link href="/blog" className="hover:text-white">Blog</Link>
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
