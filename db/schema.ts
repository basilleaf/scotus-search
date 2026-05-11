import { pgTable, text, integer, uuid, index, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const cases = pgTable('cases', {
  id: text('id').primaryKey(),
  docketId: text('docket_id'),
  name: text('name'),
  citation: text('citation'),
  year: integer('year'),
  courtId: text('court_id'),
  judges: text('judges'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
});

export const opinionChunks = pgTable(
  'opinion_chunks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    caseId: text('case_id').references(() => cases.id),
    opinionType: text('opinion_type'),
    chunkIndex: integer('chunk_index'),
    chunkText: text('chunk_text'),
    // vector(1024) — defined via raw SQL migration; Drizzle doesn't have a built-in vector type
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
  },
  (table) => [index('opinion_chunks_case_id_idx').on(table.caseId)]
);
