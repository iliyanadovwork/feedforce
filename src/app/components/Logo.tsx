import type { ComponentProps } from 'react';

/** Brand accent color (unchanged app accent green). */
export const BRAND_GREEN = '#00CD40';

/**
 * The FeedForce logo — the white mark (public/feedforcewhite.svg). It's an external monochrome SVG,
 * so it can't inherit `currentColor`/the fg token; instead the `ff-logo` class inverts it to black
 * in light mode (globals.css), which renders identically to feedforceblack.svg. Single source of
 * truth for the logo; import it instead of re-inlining it anywhere it's needed (sidebar, auth, etc.).
 *
 * Pass `className` to size it (e.g. `h-7 w-auto`). Decorative by default (empty alt); if it's the
 * only thing naming the brand, pass `role="img"` + `aria-label="FeedForce"`.
 */
export function FeedForceLogo({ className, ...props }: ComponentProps<'img'>) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/feedforcewhite.svg" alt="" className={`ff-logo select-none ${className ?? ''}`} {...props} />;
}
