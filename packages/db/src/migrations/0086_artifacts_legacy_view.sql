-- Back-compat read surface: expose declared artifacts in the
-- shape of issue_work_products for any plugin or downstream
-- consumer that previously queried that table.
--
-- This is a READ view. Writes still go to issue_work_products
-- directly (its original consumers continue working) AND to
-- artifacts via the new declare path. Plan 2 ships the one-time
-- data migration that lifts existing IWP rows into artifacts and
-- drops the original table.
--
-- Mapping rules:
--   - id ← artifact.id
--   - type ← kind
--   - provider ← 'artifact'
--   - title ← name
--   - url ← preview_url
--   - status ← 'active' for non-superseded, 'superseded' otherwise
--   - review_state ← 'none' (no review surface in artifacts yet)
--   - metadata ← content_meta
CREATE OR REPLACE VIEW artifact_work_products_compat AS
SELECT
  a.id,
  a.company_id,
  NULL::uuid AS project_id,
  a.issue_id,
  NULL::uuid AS execution_workspace_id,
  NULL::uuid AS runtime_service_id,
  a.kind AS type,
  'artifact'::text AS provider,
  a.blob_sha256 AS external_id,
  a.name AS title,
  a.preview_url AS url,
  CASE
    WHEN a.superseded_at IS NULL THEN 'active'
    ELSE 'superseded'
  END AS status,
  'none'::text AS review_state,
  false AS is_primary,
  'unknown'::text AS health_status,
  NULL::text AS summary,
  a.content_meta AS metadata,
  a.run_id AS created_by_run_id,
  a.declared_at AS created_at,
  a.declared_at AS updated_at
FROM artifacts a;
