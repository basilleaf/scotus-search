CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"docket_id" text,
	"name" text,
	"citation" text,
	"year" integer,
	"court_id" text,
	"judges" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "opinion_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" text,
	"opinion_type" text,
	"chunk_index" integer,
	"chunk_text" text,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "opinion_chunks" ADD CONSTRAINT "opinion_chunks_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opinion_chunks_case_id_idx" ON "opinion_chunks" USING btree ("case_id");
--> statement-breakpoint
CREATE INDEX ON "opinion_chunks" USING ivfflat ("embedding" vector_cosine_ops);