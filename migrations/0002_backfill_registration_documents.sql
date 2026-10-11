-- Migracion de DATOS (no generada por Drizzle Kit).
--
-- Rellena `registration_documents` con los documentos que ya existen en
-- `registrations` (titulares) y `registration_companions` (acompanantes), para que
-- la regla "un documento por evento" se aplique tambien a los registros previos.
--
-- Decisiones:
-- - Solo entran los registros vigentes (`status <> 'cancelled'`): cancelar libera
--   el documento, igual que hace el indice parcial de la tabla.
-- - Antes de esta migracion el mismo documento podia estar inscrito en varias
--   sedes del mismo evento (era legal), asi que se conserva **el mas antiguo** de
--   cada evento + documento. Sin ese filtro el indice unico aborteria la
--   migracion y el despliegue quedaria bloqueado por datos historicos.
-- - El `id` es determinista (`legacy-*` + id del registro) para que la migracion
--   sea reproducible y facil de auditar; no colisiona con los UUID del runtime.
INSERT INTO `registration_documents`
  (`id`, `event_id`, `participation_id`, `registration_id`, `role`, `document_type`, `document_number`, `status`, `released_at`, `created_at`, `updated_at`)
SELECT
  'legacy-holder-' || r.`id`, ee.`event_id`, r.`participation_id`, r.`id`, 'holder', r.`document_type`, r.`document_number`, 'active', NULL, r.`created_at`, r.`updated_at`
FROM `registrations` r
JOIN `event_establishments` ee ON ee.`id` = r.`participation_id`
WHERE r.`status` <> 'cancelled'
  AND r.`id` = (
    SELECT r2.`id`
    FROM `registrations` r2
    JOIN `event_establishments` ee2 ON ee2.`id` = r2.`participation_id`
    WHERE ee2.`event_id` = ee.`event_id`
      AND r2.`status` <> 'cancelled'
      AND r2.`document_type` = r.`document_type`
      AND r2.`document_number` = r.`document_number`
    ORDER BY r2.`registered_at`, r2.`id`
    LIMIT 1
  );--> statement-breakpoint
-- Los acompanantes entran despues: asi los documentos de titular ya ocupan su
-- lugar y solo se conserva el acompanante mas antiguo que no choque con ellos.
INSERT INTO `registration_documents`
  (`id`, `event_id`, `participation_id`, `registration_id`, `role`, `document_type`, `document_number`, `status`, `released_at`, `created_at`, `updated_at`)
SELECT
  'legacy-companion-' || c.`id`, ee.`event_id`, r.`participation_id`, c.`registration_id`, 'companion', c.`document_type`, c.`document_number`, 'active', NULL, c.`created_at`, c.`updated_at`
FROM `registration_companions` c
JOIN `registrations` r ON r.`id` = c.`registration_id`
JOIN `event_establishments` ee ON ee.`id` = r.`participation_id`
WHERE r.`status` <> 'cancelled'
  AND c.`document_type` IS NOT NULL
  AND c.`document_number` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `registration_documents` d
    WHERE d.`event_id` = ee.`event_id`
      AND d.`status` = 'active'
      AND d.`document_type` = c.`document_type`
      AND d.`document_number` = c.`document_number`
  )
  AND c.`id` = (
    SELECT c2.`id`
    FROM `registration_companions` c2
    JOIN `registrations` r2 ON r2.`id` = c2.`registration_id`
    JOIN `event_establishments` ee2 ON ee2.`id` = r2.`participation_id`
    WHERE ee2.`event_id` = ee.`event_id`
      AND r2.`status` <> 'cancelled'
      AND c2.`document_type` = c.`document_type`
      AND c2.`document_number` = c.`document_number`
    ORDER BY c2.`created_at`, c2.`id`
    LIMIT 1
  );
