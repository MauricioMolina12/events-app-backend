-- Turnos consecutivos que se entregan en puerta al escanear el QR.
--
-- `turn_counters` guarda el ultimo numero entregado por sede: la asignacion lo
-- incrementa y lee en la misma instruccion, de modo que dos escaneos simultaneos
-- reciben rangos distintos. `turns` guarda un numero por persona (titular en la
-- posicion 0 y acompanantes despues); los indices unicos impiden repetir numero
-- en una sede y asignar dos veces a la misma persona.
CREATE TABLE `turn_counters` (
	`participation_id` text PRIMARY KEY NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`participation_id`) REFERENCES `event_establishments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "turn_counters_last_number_check" CHECK("turn_counters"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`participation_id` text NOT NULL,
	`registration_id` text NOT NULL,
	`companion_id` text,
	`position` integer NOT NULL,
	`full_name` text NOT NULL,
	`number` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	`assigned_by` text,
	FOREIGN KEY (`participation_id`) REFERENCES `event_establishments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`registration_id`) REFERENCES `registrations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`companion_id`) REFERENCES `registration_companions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "turns_number_check" CHECK("turns"."number" >= 1),
	CONSTRAINT "turns_position_check" CHECK("turns"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_participation_number_unique` ON `turns` (`participation_id`,`number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_registration_position_unique` ON `turns` (`registration_id`,`position`);
