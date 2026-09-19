import type { Metadata } from "next";
import { Geist, Geist_Mono, Anton } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { RangeSliderSync } from "./components/RangeSliderSync";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const anton = Anton({
  variable: "--font-anton",
  subsets: ["latin"],
  weight: "400",
});

const SITE_NAME = "FeedForce";
const SITE_TITLE = "FeedForce - Build content automations that scale";
const SITE_DESCRIPTION =
  "Build automation workflows that turn live signals and news into on-brand content researched, designed, and published across every channel before the moment passes. Branded carousels, reels, and templates on autopilot.";

export const metadata: Metadata = {
  metadataBase: new URL("https://feedforce.ai"),
  title: {
    default: SITE_TITLE,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "social media automation",
    "carousel maker",
    "branded content templates",
    "AI content creation",
    "instagram carousel generator",
    "content repurposing",
    "social media scheduler",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
  verification: {
    google: "yP82HqMMk_RH7HGXovI1VbFlOpPuUQxl5M4GIaMezLI",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="overscroll-x-none" suppressHydrationWarning>
      {/* overscroll-x-none disables the macOS two-finger swipe-back gesture so panning the
          canvas left at its edge can't navigate the browser back (set on both html and body
          to cover viewport overscroll-behavior propagation). */}
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${anton.variable} antialiased overscroll-x-none`}
        suppressHydrationWarning
      >
        {/* No-flash theme: apply the saved choice to <html> before first paint. Default / unknown
            value = dark; retired 'light-*' variants collapse to 'light-hard' (mirrors coerce() in
            src/lib/theme.ts — KEEP the two in sync). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('ff-theme');var a=['dark','dark-hard','light','light-hard'];document.documentElement.dataset.theme=a.indexOf(t)>-1?t:(t&&t.indexOf('light-')===0?'light-hard':'dark');}catch(e){document.documentElement.dataset.theme='dark';}`,
          }}
        />
        <RangeSliderSync />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
