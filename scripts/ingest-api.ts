/**
 * SCOTUS Opinion Ingestion — CourtListener REST API edition
 *
 * Use this for targeted runs (specific date ranges, test slices).
 * No CSV downloads required. Uses the CourtListener API to fetch
 * SCOTUS opinions directly.
 *
 * Setup:
 *   1. Create a free account at https://www.courtlistener.com/sign-in/
 *   2. Get your API token at https://www.courtlistener.com/profile/
 *   3. Add to .env:  COURTLISTENER_TOKEN=your_token_here
 *
 * Usage:
 *   npm run ingest:api              # 1950–present
 *   npm run ingest:api -- --test    # 1950–1959 only
 *   npm run ingest:api -- --start 1960 --end 1969
 *
 * Resumable: already-processed (case_id, opinion_type) pairs are skipped.
 */

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { neon } from '@neondatabase/serverless';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const sql = neon(process.env.DATABASE_URL_UNPOOLED!);
const CL_TOKEN = process.env.COURTLISTENER_TOKEN;
const CL_BASE = 'https://www.courtlistener.com/api/rest/v4';
const PAGE_SIZE = 100;

const args = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const startIdx  = args.indexOf('--start');
const endIdx    = args.indexOf('--end');
const startYear = TEST_MODE ? 1950 : (startIdx !== -1 ? parseInt(args[startIdx + 1], 10) : 1950);
const endYear   = TEST_MODE ? 1959 : (endIdx   !== -1 ? parseInt(args[endIdx   + 1], 10) : 9999);
const limitIdx  = args.indexOf('--limit');
const LIMIT     = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

class LimitReached extends Error {}

const CHUNK_CHARS = 3200;   // ≈800 tokens
const OVERLAP_CHARS = 400;  // ≈100 tokens overlap
const VOYAGE_BATCH = 128;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OpinionType = 'majority' | 'concurrence' | 'dissent';

type CLCluster = {
  id: number;
  docket: string;          // URL like ".../dockets/12345/"
  sub_opinions: string[];  // URLs like [".../opinions/111/", ...]
  judges: string;
  date_filed: string;
  case_name: string;
  case_name_short: string;
};

type CLOpinion = {
  id: number;
  cluster: string;         // URL like ".../clusters/12345/"
  type: string;            // "020lead", "040dissent", etc.
  plain_text: string;
  html_with_citations: string;
  html: string;
};

type CLPage<T> = {
  next: string | null;
  results: T[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOpinionType(raw: string): OpinionType | null {
  if (['010combined', '015unanimous', '020lead', '025plurality'].includes(raw)) return 'majority';
  if (['030concurrence', '035concurrenceinpart'].includes(raw)) return 'concurrence';
  if (raw === '040dissent') return 'dissent';
  return null;
}

function idFromUrl(url: string): string {
  return url.replace(/\/$/, '').split('/').pop()!;
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_CHARS, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    if (end >= text.length) break;
    start = end - OVERLAP_CHARS;
  }
  return chunks;
}

async function clFetch<T>(url: string, retries = 3): Promise<T> {
  const args = ['-s', '--max-time', '120', '-H', 'Accept: application/json'];
  if (CL_TOKEN) args.push('-H', `Authorization: Token ${CL_TOKEN}`);
  args.push(url);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = spawnSync('curl', args, { encoding: 'utf8', timeout: 130000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`curl exit ${result.status}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout) as any;
      if (parsed?.detail) throw new Error(`CourtListener: ${parsed.detail}`);
      return parsed as T;
    } catch (err: any) {
      const msg = String(err).slice(0, 300);
      const isRateLimit = msg.includes('throttled') || msg.includes('Rate limit');
      const delay = isRateLimit ? 60000 : attempt * 5000;
      console.log(`  CL error (attempt ${attempt}): ${msg}`);
      if (attempt < retries) {
        console.log(`  retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw new Error(`CourtListener fetch failed: ${url}\n${err}`);
      }
    }
  }
  throw new Error(`CourtListener: max retries exceeded for ${url}`);
}

async function* paginate<T>(endpoint: string, params: Record<string, string>): AsyncGenerator<T> {
  const qs = new URLSearchParams({ ...params, page_size: String(PAGE_SIZE) });
  let url: string | null = `${CL_BASE}${endpoint}?${qs}`;
  while (url) {
    const page = await clFetch<CLPage<T>>(url);
    for (const item of page.results) yield item;
    url = page.next;
  }
}

async function embedBatch(texts: string[], retries = 3): Promise<number[][]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ model: 'voyage-law-2', input: texts }),
    });
    if (res.ok) {
      const data = await res.json() as { data: { embedding: number[] }[] };
      return data.data.map(d => d.embedding);
    }
    if (res.status === 429 && attempt < retries) {
      const delay = attempt * 5000;
      console.log(`  Voyage rate limit — retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    } else {
      throw new Error(`Voyage AI ${res.status}: ${await res.text()}`);
    }
  }
  throw new Error('Voyage AI: max retries exceeded');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!CL_TOKEN) {
    console.warn('Warning: COURTLISTENER_TOKEN not set — rate limits apply.');
    console.warn('  Get a free token at https://www.courtlistener.com/profile/\n');
  }

  console.log(`SCOTUS Ingestion (API) — years ${startYear}–${endYear === 9999 ? 'present' : endYear}\n`);

  // Load existing progress
  const processedKeys = new Set<string>(
    (await sql`SELECT DISTINCT case_id, opinion_type FROM opinion_chunks` as { case_id: string; opinion_type: string }[])
      .map(r => `${r.case_id}:${r.opinion_type}`)
  );
  const processedCaseIds = new Set<string>(
    (await sql`SELECT id FROM cases` as { id: string }[]).map(r => r.id)
  );
  console.log(`Resuming: ${processedCaseIds.size} cases, ${processedKeys.size} opinion sets already done\n`);

  // Fetch SCOTUS clusters (server-side date filter causes exit 56 on CourtListener)
  console.log('Fetching clusters from CourtListener API...');
  const clusters: CLCluster[] = [];
  let seen = 0;
  for await (const cluster of paginate<CLCluster>('/clusters/', { docket__court: 'scotus' })) {
    seen++;
    const year = parseInt(cluster.date_filed?.slice(0, 4) ?? '0', 10);
    if (year >= startYear && year <= endYear) clusters.push(cluster);
    if (seen >= PAGE_SIZE) break; // one page of results is enough for targeted runs
  }
  console.log(`  ${clusters.length} clusters found (scanned ${seen} total)\n`);

  // For each cluster, fetch each of its opinions by URL and process
  console.log('Processing opinions...\n');
  let done = 0;
  let skipped = 0;
  let errors = 0;

  try {
  for (const cluster of clusters) {
    const clusterId = String(cluster.id);
    const docketId = idFromUrl(cluster.docket);
    const year = parseInt(cluster.date_filed.slice(0, 4), 10);
    const caseName = cluster.case_name || cluster.case_name_short || '';

    for (const opinionUrl of cluster.sub_opinions) {
      let opinion: CLOpinion;
      try {
        opinion = await clFetch<CLOpinion>(opinionUrl);
      } catch (err) {
        errors++;
        console.error(`  ERROR fetching ${opinionUrl}:`, err);
        continue;
      }

      const opinionType = normalizeOpinionType(opinion.type);
      if (!opinionType) { skipped++; continue; }

      const key = `${clusterId}:${opinionType}`;
      if (processedKeys.has(key)) { skipped++; continue; }

      const raw = opinion.plain_text || opinion.html_with_citations || opinion.html || '';
      const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 100) { skipped++; continue; }

      try {
        // Upsert case record once per cluster
        if (!processedCaseIds.has(clusterId)) {
          await sql`
            INSERT INTO cases (id, docket_id, name, year, court_id, judges)
            VALUES (${clusterId}, ${docketId}, ${caseName}, ${year}, 'scotus', ${cluster.judges ?? ''})
            ON CONFLICT (id) DO NOTHING
          `;
          processedCaseIds.add(clusterId);
        }

        // Chunk + embed + insert
        const chunks = chunkText(text);
        for (let i = 0; i < chunks.length; i += VOYAGE_BATCH) {
          const batch = chunks.slice(i, i + VOYAGE_BATCH);
          const embeddings = await embedBatch(batch);
          await Promise.all(
            batch.map((chunk, j) => {
              const vec = `[${embeddings[j].join(',')}]`;
              return sql`
                INSERT INTO opinion_chunks (case_id, opinion_type, chunk_index, chunk_text, embedding)
                VALUES (${clusterId}, ${opinionType}, ${i + j}, ${chunk}, ${vec}::vector)
              `;
            })
          );
        }

        processedKeys.add(key);
        done++;
        console.log(`  [${done}] ${caseName} (${year}) — ${opinionType} — ${chunks.length} chunks`);
        if (done >= LIMIT) throw new LimitReached();
      } catch (err) {
        if (err instanceof LimitReached) throw err;
        errors++;
        console.error(`  ERROR processing ${clusterId} ${opinionType}:`, err);
      }
    }
  }
  } catch (e) {
    if (!(e instanceof LimitReached)) throw e;
    console.log(`\nLimit of ${LIMIT} reached — stopping early.`);
  }

  console.log(`\nDone.  Processed: ${done}  Skipped: ${skipped}  Errors: ${errors}`);
}

main().catch(console.error);
