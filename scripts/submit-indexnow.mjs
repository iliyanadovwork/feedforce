// Submits every URL in the live sitemap to IndexNow (Bing, Yandex, etc.) so
// new/changed pages get crawled without waiting for the next natural crawl.
// Requires the key file at public/<KEY>.txt to already be deployed and
// reachable at https://feedforce.ai/<KEY>.txt, otherwise IndexNow returns 403.
//
// Usage: node scripts/submit-indexnow.mjs

const HOST = 'feedforce.ai';
const KEY = '3702d3d104f7491197e8e0e6f7e6cd72';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const SITEMAP_URL = `https://${HOST}/sitemap.xml`;

async function getSitemapUrls() {
  const res = await fetch(SITEMAP_URL);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
}

async function submit(urlList) {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList }),
  });
  return res;
}

const urls = await getSitemapUrls();
console.log(`Submitting ${urls.length} URLs to IndexNow...`);
const res = await submit(urls);
console.log(`IndexNow responded ${res.status} ${res.statusText}`);
if (!res.ok) process.exitCode = 1;
