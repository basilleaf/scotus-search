import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';
import { NextRequest, NextResponse } from 'next/server';

const sql = neon(process.env.DATABASE_URL!);
const anthropic = new Anthropic();

async function embedQuery(query: string): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'voyage-law-2', input: [query], input_type: 'query' }),
  });
  if (!res.ok) throw new Error(`Voyage AI error: ${res.status}`);
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

    const sources = opinionType
      ? await sql`
          SELECT * FROM (
            SELECT DISTINCT ON (oc.case_id, oc.opinion_type)
              oc.id, oc.case_id, oc.opinion_type, oc.chunk_text,
              1 - (oc.embedding <=> ${vectorStr}::vector) AS similarity,
              c.name, c.citation, c.year, c.judges
            FROM opinion_chunks oc
            JOIN cases c ON oc.case_id = c.id
            WHERE oc.opinion_type = ${opinionType}
            ORDER BY oc.case_id, oc.opinion_type, oc.embedding <=> ${vectorStr}::vector
          ) sub
          WHERE similarity >= 0.25
          ORDER BY similarity DESC
          LIMIT 8
        `
      : await sql`
          SELECT * FROM (
            SELECT DISTINCT ON (oc.case_id, oc.opinion_type)
              oc.id, oc.case_id, oc.opinion_type, oc.chunk_text,
              1 - (oc.embedding <=> ${vectorStr}::vector) AS similarity,
              c.name, c.citation, c.year, c.judges
            FROM opinion_chunks oc
            JOIN cases c ON oc.case_id = c.id
            ORDER BY oc.case_id, oc.opinion_type, oc.embedding <=> ${vectorStr}::vector
          ) sub
          WHERE similarity >= 0.25
          ORDER BY similarity DESC
          LIMIT 8
        `;

    if (sources.length === 0) {
      return NextResponse.json({ answer: null, sources: [] });
    }

    const context = (sources as any[])
      .map((s, i) =>
        `[${i + 1}] ${s.name}${s.year ? ` (${s.year})` : ''} — ${s.opinion_type}\n${s.chunk_text}`,
      )
      .join('\n\n---\n\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system:
        'You are a legal research assistant specializing in Supreme Court jurisprudence. ' +
        'Answer the question using only the provided opinion excerpts. ' +
        'Cite cases inline by name and year, e.g. "In Roe v. Wade (1973), the Court held..." ' +
        'If the excerpts lack sufficient information, say so clearly. Be concise and precise. ' +
        'Write in plain prose paragraphs — no markdown, no headers, no bullet points.',
      messages: [
        {
          role: 'user',
          content: `Excerpts from Supreme Court opinions:\n\n${context}\n\nQuestion: ${query}`,
        },
      ],
    });

    const answer =
      message.content[0].type === 'text' ? message.content[0].text : '';

    return NextResponse.json({ answer, sources });
  } catch (err) {
    console.error('Ask error:', err);
    return NextResponse.json({ error: 'Ask failed' }, { status: 500 });
  }
}
