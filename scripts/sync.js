import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const destination = fileURLToPath(new URL('../data/movies.json', import.meta.url));
const api = 'https://api.github.com/repos/qun950303/jasna-ltx';
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'jasna-ltx-sync' };
const metadataResponse = await fetch(`${api}/contents/data/movies.json`, {
  headers,
  signal: AbortSignal.timeout(60000),
});
if (!metadataResponse.ok) throw new Error(`Upstream lookup failed: HTTP ${metadataResponse.status}`);
const metadata = await metadataResponse.json();
if (!/^[0-9a-f]{40}$/.test(metadata.sha ?? '')) throw new Error('Invalid upstream file SHA');

const blobResponse = await fetch(`${api}/git/blobs/${metadata.sha}`, {
  headers,
  signal: AbortSignal.timeout(60000),
});
if (!blobResponse.ok) throw new Error(`Upstream download failed: HTTP ${blobResponse.status}`);
const blob = await blobResponse.json();
if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
  throw new Error('Unexpected upstream blob encoding');
}
const incoming = Buffer.from(blob.content, 'base64').toString('utf8');
const parsed = JSON.parse(incoming);
if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || parsed.items.length === 0) {
  throw new Error('Upstream data has no nonempty items list; refusing to replace local data');
}

const existing = await readFile(destination, 'utf8');
if (incoming === existing) {
  console.log(`No changes (${parsed.items.length} items).`);
  process.exit(0);
}

const current = JSON.parse(existing);
if (Array.isArray(current.items) && parsed.items.length < current.items.length) {
  throw new Error(`Upstream item count decreased from ${current.items.length} to ${parsed.items.length}; review manually`);
}

const temporary = `${destination}.tmp`;
try {
  await writeFile(temporary, incoming, 'utf8');
  await rename(temporary, destination);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}
console.log(`Updated data: ${current.items?.length ?? 0} -> ${parsed.items.length} items.`);
