import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Social share card (og:image + twitter:image), generated at build time.
// Next wires it into the metadata automatically because of the file name.
export const alt = 'FeedForce — Control the force behind the feed';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  const wordmarkFont = await readFile(join(process.cwd(), 'public', 'neue-montreal-bold.otf'));

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#000',
          backgroundImage: 'radial-gradient(ellipse 60% 55% at 50% 45%, rgba(255,255,255,0.08), transparent)',
          color: '#fff',
          fontFamily: 'Neue Montreal',
        }}
      >
        <div style={{ fontSize: 110, fontWeight: 700, letterSpacing: '-0.03em' }}>FeedForce</div>
        <div style={{ fontSize: 38, marginTop: 28, color: 'rgba(255,255,255,0.72)' }}>
          Control the force behind the feed.
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: 'Neue Montreal', data: wordmarkFont, style: 'normal', weight: 700 }],
    },
  );
}
