'use client';

import { useState } from 'react';

type SearchResult = {
  id: string;
  case_id: string;
  opinion_type: string;
  chunk_text: string;
  similarity: number;
  name: string;
  citation: string | null;
  year: number | null;
  judges: string | null;
};

const OPINION_LABELS: Record<string, string> = {
  majority: 'Majority',
  concurrence: 'Concurrence',
  dissent: 'Dissent',
  combined: 'Combined',
  unknown: 'Unknown',
};

function courtListenerUrl(caseId: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `https://www.courtlistener.com/opinion/${caseId}/${slug}/`;
}

const OPINION_COLORS: Record<string, { bg: string; text: string }> = {
  majority: { bg: '#dbeafe', text: '#1d4ed8' },
  concurrence: { bg: '#ede9fe', text: '#7c3aed' },
  dissent: { bg: '#fee2e2', text: '#dc2626' },
};

export default function Home() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<'search' | 'ask'>('search');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');

  async function run(activeMode: 'search' | 'ask', activeFilter: string) {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    setError('');
    setAnswer(null);
    setResults([]);
    try {
      const params = new URLSearchParams({ q: query.trim() });
      if (activeFilter) params.set('type', activeFilter);
      const endpoint = activeMode === 'ask' ? '/api/ask' : '/api/search';
      const res = await fetch(`${endpoint}?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      if (activeMode === 'ask') {
        setAnswer(data.answer ?? null);
        setResults(data.sources ?? []);
      } else {
        setResults(data.results ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent, submitMode: 'search' | 'ask') {
    e.preventDefault();
    setMode(submitMode);
    run(submitMode, filter);
  }

  function handleFilterClick(type: string) {
    setFilter(type);
    if (searched) run(mode, type);
  }

  const filterOptions = [
    { value: '', label: 'All' },
    { value: 'majority', label: 'Majority' },
    { value: 'dissent', label: 'Dissent' },
    { value: 'concurrence', label: 'Concurrence' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#fafaf9' }}>
      <div style={{ maxWidth: 768, margin: '0 auto', padding: '48px 24px 80px' }}>
        <div style={{ marginBottom: 40 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: '#1c1917', letterSpacing: '-0.3px', margin: '0 0 8px' }}>
            SCOTUS Semantic Search
          </h1>
          <p style={{ fontSize: 15, color: '#78716c', margin: 0 }}>
            Search Supreme Court opinions by legal concept — majority, dissent, and concurrence searchable separately.
          </p>
        </div>

        <form style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(mode, filter); } }}
            placeholder="e.g. right to privacy, cruel and unusual punishment, equal protection..."
            style={{
              flex: 1,
              padding: '10px 14px',
              fontSize: 15,
              border: '1px solid #d6d3d1',
              borderRadius: 8,
              background: '#fff',
              color: '#1c1917',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            onClick={e => handleSubmit(e, 'search')}
            disabled={loading || !query.trim()}
            style={{
              padding: '10px 20px',
              background: mode === 'search' && searched ? '#1c1917' : '#fff',
              color: mode === 'search' && searched ? '#fff' : '#1c1917',
              border: '1px solid #1c1917',
              borderRadius: 8,
              fontSize: 15,
              fontWeight: 500,
              cursor: loading || !query.trim() ? 'not-allowed' : 'pointer',
              opacity: loading || !query.trim() ? 0.55 : 1,
              whiteSpace: 'nowrap',
              fontFamily: 'inherit',
            }}
          >
            Search
          </button>
          <button
            type="submit"
            onClick={e => handleSubmit(e, 'ask')}
            disabled={loading || !query.trim()}
            style={{
              padding: '10px 20px',
              background: mode === 'ask' && searched ? '#1c1917' : '#fff',
              color: mode === 'ask' && searched ? '#fff' : '#1c1917',
              border: '1px solid #1c1917',
              borderRadius: 8,
              fontSize: 15,
              fontWeight: 500,
              cursor: loading || !query.trim() ? 'not-allowed' : 'pointer',
              opacity: loading || !query.trim() ? 0.55 : 1,
              whiteSpace: 'nowrap',
              fontFamily: 'inherit',
            }}
          >
            {loading && mode === 'ask' ? 'Analyzing…' : 'Ask'}
          </button>
        </form>

        <div style={{ display: 'flex', gap: 6, marginBottom: 36 }}>
          {filterOptions.map(({ value, label }) => (
            <button
              key={value || 'all'}
              onClick={() => handleFilterClick(value)}
              style={{
                padding: '4px 12px',
                borderRadius: 999,
                border: '1px solid',
                fontSize: 13,
                cursor: 'pointer',
                background: filter === value ? '#1c1917' : '#fff',
                color: filter === value ? '#fff' : '#78716c',
                borderColor: filter === value ? '#1c1917' : '#d6d3d1',
                fontFamily: 'inherit',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <p style={{ color: '#dc2626', fontSize: 14, marginBottom: 16 }}>{error}</p>
        )}

        {loading && (
          <p style={{ color: '#78716c', fontSize: 15 }}>
            {mode === 'ask' ? 'Analyzing opinions…' : 'Searching…'}
          </p>
        )}

        {!loading && searched && mode === 'ask' && answer === null && results.length === 0 && !error && (
          <p style={{ color: '#78716c', fontSize: 15 }}>No relevant opinions found for that question.</p>
        )}

        {!loading && searched && mode === 'search' && results.length === 0 && !error && (
          <p style={{ color: '#78716c', fontSize: 15 }}>No results found.</p>
        )}

        {answer && (
          <div
            style={{
              background: '#fff',
              border: '1px solid #e7e5e4',
              borderLeft: '3px solid #1c1917',
              borderRadius: 12,
              padding: '20px 24px',
              marginBottom: 28,
            }}
          >
            <p style={{ fontSize: 12, fontWeight: 600, color: '#a8a29e', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 12px' }}>
              Analysis
            </p>
            <p style={{ fontSize: 15, color: '#1c1917', lineHeight: 1.75, margin: 0, whiteSpace: 'pre-wrap' }}>
              {answer}
            </p>
          </div>
        )}

        {results.length > 0 && (
          <>
            {mode === 'ask' && (
              <p style={{ fontSize: 12, fontWeight: 600, color: '#a8a29e', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
                Sources
              </p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {results.map(r => {
                const opinionColors = OPINION_COLORS[r.opinion_type] ?? { bg: '#f5f5f4', text: '#57534e' };
                const excerpt = r.chunk_text.length > 420 ? r.chunk_text.slice(0, 420) + '…' : r.chunk_text;

                return (
                  <div
                    key={r.id}
                    style={{
                      background: '#fff',
                      border: '1px solid #e7e5e4',
                      borderRadius: 12,
                      padding: '18px 22px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
                      <div>
                        <a
                          href={courtListenerUrl(r.case_id, r.name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontWeight: 600, fontSize: 15, color: '#1c1917', textDecoration: 'none' }}
                          onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                          onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                        >
                          {r.name}
                        </a>
                        {(r.year || r.citation) && (
                          <span style={{ color: '#a8a29e', fontSize: 13, marginLeft: 8 }}>
                            {[r.year, r.citation].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 12, color: '#a8a29e', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        {Math.round(r.similarity * 100)}% match
                      </span>
                    </div>

                    <div style={{ marginBottom: 10 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: '0.4px',
                          textTransform: 'uppercase' as const,
                          background: opinionColors.bg,
                          color: opinionColors.text,
                        }}
                      >
                        {OPINION_LABELS[r.opinion_type] ?? r.opinion_type}
                      </span>
                    </div>

                    <p style={{ fontSize: 14, color: '#57534e', lineHeight: 1.65, margin: 0 }}>
                      {excerpt}
                    </p>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
