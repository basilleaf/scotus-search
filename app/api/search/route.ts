import { neon } from '@neondatabase/serverless';
import { NextRequest, NextResponse } from 'next/server';

const sql = neon(process.env.DATABASE_URL!);

async function embedQuery(query: string): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-law-2',
      input: [query],
      input_type: 'query',
    }),
  });
  if (!res.ok) throw new Error(`Voyage AI error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.data[0].embedding;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const query = searchParams.get('q');
  const opinionType = searchParams.get('type');

  if (!query?.trim()) {
    return NextResponse.json({ error: 'q is required' }, { status: 400 });
  }

  try {
    const embedding = await embedQuery(query.trim());
    const vectorStr = `[${embedding.join(',')}]`;

    const MIN_SIMILARITY = 0.30;

    const rows = opinionType
      ? await sql`
          SELECT * FROM (
            SELECT DISTINCT ON (oc.case_id, oc.opinion_type)
              oc.id,
              oc.case_id,
              oc.opinion_type,
              oc.chunk_text,
              1 - (oc.embedding <=> ${vectorStr}::vector) AS similarity,
              c.name,
              c.citation,
              c.year,
              c.judges
            FROM opinion_chunks oc
            JOIN cases c ON oc.case_id = c.id
            WHERE oc.opinion_type = ${opinionType}
            ORDER BY oc.case_id, oc.opinion_type, oc.embedding <=> ${vectorStr}::vector
          ) sub
          WHERE similarity >= ${MIN_SIMILARITY}
          ORDER BY similarity DESC
          LIMIT 15
        `
      : await sql`
          SELECT * FROM (
            SELECT DISTINCT ON (oc.case_id, oc.opinion_type)
              oc.id,
              oc.case_id,
              oc.opinion_type,
              oc.chunk_text,
              1 - (oc.embedding <=> ${vectorStr}::vector) AS similarity,
              c.name,
              c.citation,
              c.year,
              c.judges
            FROM opinion_chunks oc
            JOIN cases c ON oc.case_id = c.id
            ORDER BY oc.case_id, oc.opinion_type, oc.embedding <=> ${vectorStr}::vector
          ) sub
          WHERE similarity >= ${MIN_SIMILARITY}
          ORDER BY similarity DESC
          LIMIT 15
        `;

    return NextResponse.json({ results: rows });
  } catch (err) {
    console.error('Search error:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
