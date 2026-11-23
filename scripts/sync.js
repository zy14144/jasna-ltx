import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const destination = fileURLToPath(new URL('../data/movies.json', import.meta.url));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'jasna-ltx-sync' };
if (token) headers.Authorization = `Bearer ${token}`;

// 主源：qun950303（收录最全）
const PRIMARY = { owner: 'qun950303', repo: 'jasna-ltx', branch: 'main' };
// 副源：DowenAI（独立数据，含主源缺失的番号）
const SECONDARY = { owner: 'DowenAI', repo: 'jasna-ltx-site', branch: 'main' };

const apiBase = (u) => `https://api.github.com/repos/${u.owner}/${u.repo}`;
const rawUrl = (u) => `https://raw.githubusercontent.com/${u.owner}/${u.repo}/${u.branch}/data/movies.json`;

async function fetchViaApi(u) {
  const metaRes = await fetch(`${apiBase(u)}/contents/data/movies.json?ref=${u.branch}`, {
    headers,
    signal: AbortSignal.timeout(60000),
  });
  if (!metaRes.ok) throw new Error(`metadata HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  if (!/^[0-9a-f]{40}$/.test(meta.sha ?? '')) throw new Error('invalid upstream SHA');
  const blobRes = await fetch(`${apiBase(u)}/git/blobs/${meta.sha}`, {
    headers,
    signal: AbortSignal.timeout(60000),
  });
  if (!blobRes.ok) throw new Error(`blob HTTP ${blobRes.status}`);
  const blob = await blobRes.json();
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error('unexpected blob encoding');
  }
  return Buffer.from(blob.content, 'base64').toString('utf8');
}

async function fetchViaRaw(u) {
  const res = await fetch(rawUrl(u), {
    headers: { 'User-Agent': 'jasna-ltx-sync', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`raw HTTP ${res.status}`);
  return await res.text();
}

async function loadUpstream(u, label) {
  try {
    const text = await fetchViaApi(u);
    return JSON.parse(text);
  } catch (error) {
    console.log(`[${label}] API unavailable (${error.message}); using raw download.`);
    const text = await fetchViaRaw(u);
    return JSON.parse(text);
  }
}

function validate(data, label) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items) || data.items.length === 0) {
    throw new Error(`${label}: no nonempty items list`);
  }
  return data;
}

// /api/img?w=800&u=<编码后的真实地址> -> 真实地址
function unwrapImage(url) {
  if (typeof url !== 'string') return url;
  if (url.startsWith('/api/img?')) {
    try {
      const u = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('u');
      if (u && /^https?:\/\//i.test(u)) return u;
    } catch {
      /* 保持原样 */
    }
  }
  return url;
}

function normalizeItem(item) {
  return { ...item, cover: unwrapImage(item.cover), shot: unwrapImage(item.shot) };
}

function rebuildTotals(data) {
  const actorCount = new Map();
  const genreCount = new Map();
  for (const it of data.items) {
    for (const a of it.actors ?? []) if (a) actorCount.set(a, (actorCount.get(a) ?? 0) + 1);
    for (const g of it.genres ?? []) {
      if (typeof g === 'string' && /^c\d+=\d+$/.test(g)) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
    }
  }
  const sorted = [...actorCount.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  data.actorTotals = sorted;
  data.actors = sorted;
  data.genreTotals = [...genreCount.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  return data;
}

const existingRaw = await readFile(destination, 'utf8');
const existing = JSON.parse(existingRaw);
const before = existing.items?.length ?? 0;

let primary;
let primaryIsSecondary = false;
try {
  primary = validate(await loadUpstream(PRIMARY, 'primary'), 'primary');
} catch (error) {
  console.log(`[primary] failed: ${error.message}. Falling back to secondary as the base dataset.`);
  primary = validate(await loadUpstream(SECONDARY, 'secondary'), 'secondary');
  primaryIsSecondary = true;
}

let secondary = null;
if (!primaryIsSecondary) {
  try {
    secondary = validate(await loadUpstream(SECONDARY, 'secondary'), 'secondary');
  } catch (error) {
    console.log(`[secondary] unavailable (${error.message}); syncing primary only.`);
  }
}

const byCode = new Map();
for (const it of primary.items) {
  if (!it?.code) continue;
  // 万一回退到副源当底座，也要滤掉没有下载链接的占位条目
  if (primaryIsSecondary && !(Array.isArray(it.links) && it.links.length > 0)) continue;
  byCode.set(it.code, it);
}

// 之前从副源并进来的条目继续保留（防止副源临时缺条导致数量回退）
let carried = 0;
for (const it of existing.items ?? []) {
  if (it?.code && !byCode.has(it.code)) {
    byCode.set(it.code, it);
    carried += 1;
  }
}

let added = 0;
const avatars = { ...(primary.avatars ?? {}) };
if (secondary) {
  for (const raw of secondary.items) {
    const code = raw?.code;
    if (!code || byCode.has(code)) continue;
    if (!Array.isArray(raw.links) || raw.links.length === 0) continue; // 尚无下载链接的占位条目不收录
    byCode.set(code, normalizeItem(raw));
    added += 1;
  }
  for (const [name, url] of Object.entries(secondary.avatars ?? {})) {
    if (!avatars[name]) avatars[name] = unwrapImage(url);
  }
}

const merged = { ...primary, items: [...byCode.values()], avatars };
// 页面上的“资源更新于”只跟主源走，避免副源重扫一次就显示成“有新数据”
if (primary.updated_at) merged.updated_at = primary.updated_at;

rebuildTotals(merged);

if (merged.items.length < before) {
  throw new Error(`item count decreased from ${before} to ${merged.items.length}; review manually`);
}

const outgoing = JSON.stringify(merged);
if (outgoing === existingRaw || JSON.stringify(existing) === outgoing) {
  console.log(`No changes (${merged.items.length} items).`);
  process.exit(0);
}

const temporary = `${destination}.tmp`;
try {
  await writeFile(temporary, outgoing, 'utf8');
  await rename(temporary, destination);
} catch (error) {
  await unlink(temporary).catch(() => {});
  throw error;
}

if (added > 0) console.log(`Merged ${added} new items from secondary upstream.`);
if (carried > 0) console.log(`Kept ${carried} previously merged items not present upstream.`);
console.log(`Updated data: ${before} -> ${merged.items.length} items.`);
