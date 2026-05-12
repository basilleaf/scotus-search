/**
 * SCOTUS Opinion Ingestion Script
 *
 * No local CSV files needed — all three bulk files stream directly from S3.
 * Update the S3 URL constants below when CourtListener publishes a newer export.
 *
 * Usage:
 *   npm run ingest            # Full run  (1950+)
 *   npm run ingest -- --test  # Test run  (1950–1959 only)
 *
 * Resumable: safe to stop and restart.
 */

import 'dotenv/config';
import { existsSync } from 'fs';
import { createReadStream } from 'fs';
import { spawn } from 'node:child_process';
import { parse } from 'csv-parse';
import { neon } from '@neondatabase/serverless';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const sql = neon(process.env.DATABASE_URL_UNPOOLED!);

const TEST_MODE = process.argv.includes('--test');
const VERBOSE   = process.argv.includes('--verbose');
const limitIdx  = process.argv.indexOf('--limit');
const LIMIT     = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;
const MIN_YEAR  = 1950;
const MAX_YEAR  = TEST_MODE ? 1959 : Infinity;

class LimitReached extends Error {}

const CHUNK_CHARS = 3200;    // ≈800 tokens at 4 chars/token
const OVERLAP_CHARS = 400;   // ≈100 tokens overlap
const VOYAGE_BATCH = 128;    // Voyage AI max texts per request
const VOYAGE_DELAY_MS = 1500; // pause between embed calls — keeps free tier under ~40 RPM

const DATA_DIR = 'scripts/data';

// Update these when CourtListener publishes a newer quarterly export.
const S3 = 'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data';
const DOCKETS_URL     = `${S3}/dockets-2026-03-31.csv.bz2`;
const CLUSTERS_URL    = `${S3}/opinion-clusters-2026-03-31.csv.bz2`;
const OPINIONS_URL    = `${S3}/opinions-2026-03-31.csv.bz2`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClusterInfo = {
  docketId: string;
  caseName: string;
  year: number;
  judges: string;
};

type OpinionType = 'majority' | 'concurrence' | 'dissent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOpinionType(raw: string): OpinionType | null {
  // CourtListener type codes:
  // 010combined, 015unanimous, 020lead, 025plurality → majority
  // 030concurrence, 035concurrenceinpart             → concurrence
  // 040dissent                                       → dissent
  if (['010combined', '015unanimous', '020lead', '025plurality'].includes(raw)) return 'majority';
  if (['030concurrence', '035concurrenceinpart'].includes(raw)) return 'concurrence';
  if (raw === '040dissent') return 'dissent';
  return null;
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
      await new Promise(r => setTimeout(r, VOYAGE_DELAY_MS));
      return data.data.map(d => d.embedding);
    }
    if (res.status === 429 && attempt < retries) {
      const delay = attempt * 5000;
      console.log(`  Rate limited — retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    } else {
      const err = await res.text();
      throw new Error(`Voyage AI error ${res.status}: ${err}`);
    }
  }
  throw new Error('Voyage AI: exceeded max retries');
}

const CSV_OPTS = {
  columns: true,
  skip_empty_lines: true,
  bom: true,
  relax_column_count: true,
  relax_quotes: true,       // CourtListener CSVs have unescaped quotes in case names
  quote: '"' as const,
};

async function streamCsv(
  path: string,
  onRow: (row: Record<string, string>) => Promise<void>
): Promise<void> {
  const parser = createReadStream(path).pipe(parse(CSV_OPTS));
  for await (const row of parser) {
    await onRow(row as Record<string, string>);
  }
}

// Streams a remote bzip2-compressed CSV without saving to disk.
// Pipes: curl → bzip2 -d → csv-parse → onRow
async function streamCsvFromS3(
  url: string,
  onRow: (row: Record<string, string>) => Promise<void>
): Promise<void> {
  const curl = spawn('curl', ['-s', '--retry', '3', '--retry-delay', '5', url]);
  const bzip2 = spawn('bzip2', ['-d']);
  curl.stdout.pipe(bzip2.stdin);

  // Suppress EPIPE errors from killing processes mid-stream
  curl.stdout.on('error', () => {});
  bzip2.stdin.on('error', () => {});
  bzip2.stdout.on('error', () => {});

  curl.on('close', (code) => {
    if (code !== 0) bzip2.stdin.destroy(new Error(`curl exited with code ${code}`));
  });

  const parser = bzip2.stdout.pipe(parse(CSV_OPTS));

  try {
    for await (const row of parser) {
      await onRow(row as Record<string, string>);
    }
  } finally {
    curl.kill();
    bzip2.kill();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`SCOTUS Ingestion — ${TEST_MODE ? 'TEST MODE (1950–1959)' : 'FULL MODE (1950+)'}\n`);

  const stream = (localName: string, s3Url: string) => {
    const local = `${DATA_DIR}/${localName}`;
    return existsSync(local)
      ? (cb: Parameters<typeof streamCsv>[1]) => streamCsv(local, cb)
      : (cb: Parameters<typeof streamCsv>[1]) => streamCsvFromS3(s3Url, cb);
  };

  // Phase 1: Load SCOTUS docket IDs
  console.log('[1/4] Loading dockets...');
  const scotusDocketIds = new Set<string>();
  let docketRows = 0;
  await stream('dockets.csv', DOCKETS_URL)(async (row) => {
    docketRows++;
    if (VERBOSE && docketRows % 100_000 === 0) process.stdout.write(`\r      ${docketRows.toLocaleString()} rows scanned, ${scotusDocketIds.size} SCOTUS found...`);
    if (row.court_id === 'scotus') scotusDocketIds.add(row.id);
  });
  if (VERBOSE) process.stdout.write('\n');
  console.log(`      ${scotusDocketIds.size} SCOTUS dockets found (scanned ${docketRows.toLocaleString()} total)`);

  // Phase 2: Load cluster metadata, filtered to SCOTUS + year range
  console.log('\n[2/4] Loading opinion clusters...');
  const clusters = new Map<string, ClusterInfo>();
  let clusterRows = 0;
  await stream('opinion-clusters.csv', CLUSTERS_URL)(async (row) => {
    clusterRows++;
    if (VERBOSE && clusterRows % 100_000 === 0) process.stdout.write(`\r      ${clusterRows.toLocaleString()} rows scanned, ${clusters.size} SCOTUS clusters found...`);
    if (!scotusDocketIds.has(row.docket_id)) return;
    const year = row.date_filed ? parseInt(row.date_filed.slice(0, 4), 10) : 0;
    if (year < MIN_YEAR || year > MAX_YEAR) return;
    clusters.set(row.id, {
      docketId: row.docket_id,
      caseName: row.case_name || row.case_name_short || '',
      year,
      judges: row.judges || '',
    });
  });
  if (VERBOSE) process.stdout.write('\n');
  console.log(`      ${clusters.size} clusters in year range (scanned ${clusterRows.toLocaleString()} total)`);

  // Phase 3: Check what's already in the DB (for resumability)
  console.log('\n[3/4] Checking existing DB state...');
  const existingCasesResult = await sql`SELECT id FROM cases`;
  const processedCaseIds = new Set<string>(
    (existingCasesResult as { id: string }[]).map(r => r.id)
  );

  const existingChunksResult = await sql`SELECT DISTINCT case_id, opinion_type FROM opinion_chunks`;
  const processedChunkKeys = new Set<string>(
    (existingChunksResult as { case_id: string; opinion_type: string }[])
      .map(r => `${r.case_id}:${r.opinion_type}`)
  );
  console.log(`      ${processedCaseIds.size} cases and ${processedChunkKeys.size} (case, opinion_type) pairs already done`);

  // Phase 4: Stream opinions and process
  const opinionsLocal = existsSync(`${DATA_DIR}/opinions.csv`);
  console.log(`\n[4/4] Processing opinions — ${opinionsLocal ? 'local file' : 'streaming from S3'}...\n`);
  let done = 0;
  let skipped = 0;
  let errors = 0;

  const streamOpinions = stream('opinions.csv', OPINIONS_URL);

  try {
   await streamOpinions(async (row) => {
    const clusterId = row.cluster_id;
    const cluster = clusters.get(clusterId);
    if (!cluster) {
      const total = done + skipped + errors;
      if (total % 500_000 === 0 && total > 0) process.stdout.write(`\r      scanning... ${(total / 1_000_000).toFixed(1)}M rows, ${done} processed`);
      else if (VERBOSE && total % 100_000 === 0 && total > 0) process.stdout.write(`\r      scanning... ${total.toLocaleString()} rows`);
      return;
    }

    const opinionType = normalizeOpinionType(row.type);
    if (!opinionType) return;

    const chunkKey = `${clusterId}:${opinionType}`;
    if (processedChunkKeys.has(chunkKey)) { skipped++; return; }

    const raw = row.plain_text || row.html_with_citations || row.html || '';
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 100) { skipped++; return; }

    try {
      // Upsert case record (once per case_id)
      if (!processedCaseIds.has(clusterId)) {
        await sql`
          INSERT INTO cases (id, docket_id, name, year, court_id, judges)
          VALUES (
            ${clusterId},
            ${cluster.docketId},
            ${cluster.caseName},
            ${cluster.year},
            'scotus',
            ${cluster.judges}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        processedCaseIds.add(clusterId);
      }

      // Chunk the opinion
      const chunks = chunkText(text);

      // Embed in batches, insert as we go
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

      processedChunkKeys.add(chunkKey);
      done++;
      console.log(`  [${done}] ${cluster.caseName} (${cluster.year}) — ${opinionType} — ${chunks.length} chunks`);
      if (done >= LIMIT) throw new LimitReached();
    } catch (err) {
      if (err instanceof LimitReached) throw err;
      errors++;
      console.error(`  ERROR: ${clusterId} ${opinionType}:`, err);
    }
  });
  } catch (e) {
    if (!(e instanceof LimitReached)) throw e;
    console.log(`\nLimit of ${LIMIT} reached — stopping early.`);
  }

  console.log(`\nDone.  Processed: ${done}  Skipped: ${skipped}  Errors: ${errors}`);
}

main().catch(console.error);
