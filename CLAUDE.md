# SCOTUS Semantic Search — Project Context

A Next.js RAG app that lets you search Supreme Court opinions by concept and legal meaning, not just keywords. Two core use cases:

1. "Find cases similar to this legal situation" (vector similarity)
2. "What has SCOTUS said about X across history" (RAG synthesis with citations)

**Portfolio differentiator:** majority, concurrence, and dissent are chunked and tagged separately — you can ask "what did dissenters say about X" which no mainstream legal tool does well.

---

## Stack

- **Framework:** Next.js (App Router)
- **Database:** Neon PostgreSQL + pgvector extension
- **ORM:** Drizzle ORM
- **Embeddings:** Voyage AI — `voyage-law-2` (1024 dims, law-specific model)
- **AI synthesis:** Anthropic API (Claude)
- **Data source:** CourtListener / Free Law Project bulk CSV exports
- **Auth:** Clerk (optional / TBD)

---

## Data Source

CourtListener bulk data: https://www.courtlistener.com/help/api/bulk-data/

Three CSVs needed:

- `dockets.csv` — case name, docket number
- `opinion-clusters.csv` — groups opinions per case, holds metadata (date, court, justices)
- `opinions.csv` — actual text with `type` field (majority/concurrence/dissent)

Full `opinions.csv` is 190+ GB but filter to `court_id = 'scotus'` reduces it dramatically. Stream and filter — do NOT load into memory.

Scope: start with **modern era only (1950s+, ~8k cases)** before expanding to full corpus.

---

## Database Schema

```sql
-- One row per case
CREATE TABLE cases (
  id          TEXT PRIMARY KEY,  -- cluster_id from CourtListener
  docket_id   TEXT,
  name        TEXT,
  citation    TEXT,              -- e.g. "410 U.S. 113"
  year        INTEGER,
  court_id    TEXT,              -- always 'scotus'
  judges      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- One row per text chunk (no separate full-text opinions table needed)
CREATE TABLE opinion_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       TEXT REFERENCES cases(id),
  opinion_type  TEXT,   -- 'majority' | 'concurrence' | 'dissent'
  chunk_index   INTEGER,
  chunk_text    TEXT,
  embedding     vector(1024),  -- voyage-law-2 dimensions
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON opinion_chunks
  USING ivfflat (embedding vector_cosine_ops);
```

**Key decisions:**

- No raw full-text stored — chunks only
- `opinion_type` on each chunk enables filtering by majority/dissent
- ivfflat index for fast cosine similarity search

---

## Ingestion Script — `scripts/ingest.ts`

Run once locally to populate the DB. Not part of the app.

```
1. Stream opinions CSV, filter court_id = 'scotus' and year >= 1950
2. For each opinion row:
   a. Look up cluster metadata (case name, citation, year, judges)
   b. Upsert into `cases` table
   c. Chunk plain_text (~800 tokens, ~100 token overlap)
   d. Batch embed chunks via Voyage AI (max 128 per request)
   e. Bulk insert into opinion_chunks
3. Track progress (check if case_id already exists — skip if so)
```

**Resumability is critical** — script must be safe to stop and restart without re-embedding completed cases.

---

## App Structure

```
/app
  /api
    /search       — vector similarity search route handler
    /ask          — RAG synthesis route handler
  /page.tsx       — main search UI
/scripts
  ingest.ts       — one-off ingestion script
/db
  schema.ts       — Drizzle schema
  index.ts        — Neon client
```

---

## Milestones

- [x] **Milestone 1 — Project scaffold**
  - Next.js project init
  - Neon DB provisioned, pgvector enabled
  - Drizzle schema + migration run
  - Env vars configured (Neon, Voyage AI, Anthropic)

- [x] **Milestone 2 — Ingestion script (small slice)**
  - Download CourtListener CSVs
  - Write `scripts/ingest.ts`
  - Test on 1950s cases only (~100 cases) before full run
  - Verify chunks + embeddings land in DB correctly

- [] **Milestone 3 — Full ingestion**
  - Run ingest for all post-1950 SCOTUS opinions
  - Confirm resumability works
  - Spot-check data quality (chunk lengths, opinion_type tagging)

- [ ] **Milestone 4 — Similarity search**
  - `/api/search` route: embed query via Voyage AI, cosine similarity against `opinion_chunks`
  - Return top N chunks with case metadata
  - Basic UI: search box → results list with case name, year, citation, opinion type, excerpt

- [ ] **Milestone 5 — RAG synthesis**
  - `/api/ask` route: retrieve top chunks, pass to Claude with prompt
  - Claude synthesizes an answer with inline citations
  - UI: conversational answer above source cards

- [ ] **Milestone 6 — Polish**
  - Filter by opinion type (majority / dissent / concurrence)
  - Filter by date range
  - Rate limiting (Upstash Redis) on API routes
  - Deploy to Vercel

---

## Notes & Gotchas

- Use `fetch` directly for Voyage AI — the `voyageai` SDK has Turbopack/Next.js compatibility issues (learned from Ask Jane)
- Neon connection string: watch for `channel_binding=require` issues — use pooled connection string from Neon dashboard
- Add a query result cache table (like Ask Jane's `searches` table) to avoid redundant Voyage + Anthropic API calls on repeated queries
- Voyage AI `voyage-law-2` is the same price tier as general models but significantly better for legal text
- Consider Clerk auth if the app goes public — open RAG endpoints can get expensive fast
