-- Cupo general del evento: techo de personas (titulares + acompanantes)
-- que pueden asignarse entre todas las sedes no canceladas.
ALTER TABLE `events` ADD `capacity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `events`
SET `capacity` = MAX(
  `capacity`,
  COALESCE(
    (
      SELECT SUM(`titular_capacity` + `companion_capacity`)
      FROM `event_establishments`
      WHERE `event_establishments`.`event_id` = `events`.`id`
        AND `event_establishments`.`status` <> 'cancelled'
    ),
    0
  )
);
