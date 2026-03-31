ALTER TABLE "document_revisions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "format" text DEFAULT 'markdown' NOT NULL;
--> statement-breakpoint
UPDATE "document_revisions" AS "dr"
SET
  "title" = "d"."title",
  "format" = COALESCE("d"."format", 'markdown')
FROM "documents" AS "d"
WHERE "d"."id" = "dr"."document_id";
