-- Un cliente por operador. El correo sigue siendo la cuenta; el slug es estable.
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`name_customized` integer DEFAULT 0 NOT NULL,
	`primary_color` text DEFAULT '#C81F68' NOT NULL,
	`color_customized` integer DEFAULT 0 NOT NULL,
	`owner_user_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "clients_name_check" CHECK(length("clients"."display_name") BETWEEN 1 AND 80),
	CONSTRAINT "clients_color_check" CHECK("clients"."primary_color" GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'),
	CONSTRAINT "clients_name_flag_check" CHECK("clients"."name_customized" IN (0, 1)),
	CONSTRAINT "clients_color_flag_check" CHECK("clients"."color_customized" IN (0, 1)),
	CONSTRAINT "clients_status_check" CHECK("clients"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_slug_unique` ON `clients` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_owner_unique` ON `clients` (`owner_user_id`);
--> statement-breakpoint
INSERT INTO `clients` (
	`id`, `slug`, `display_name`, `name_customized`, `primary_color`, `color_customized`,
	`owner_user_id`, `status`, `created_at`, `updated_at`
)
SELECT
	lower(hex(randomblob(16))),
	lower(
		replace(replace(replace(replace(
			CASE
				WHEN instr(`email`, '@') > 1 THEN substr(`email`, 1, instr(`email`, '@') - 1)
				ELSE 'cliente'
			END,
		'.', '-'), '_', '-'), '+', '-'), ' ', '-')
	),
	CASE
		WHEN (SELECT count(*) FROM `users` WHERE `role` = 'operator') = 1
			AND (SELECT `name_customized` FROM `workspace_settings` WHERE `id` = 'default') = 1
		THEN (SELECT `display_name` FROM `workspace_settings` WHERE `id` = 'default')
		ELSE `full_name`
	END,
	1,
	CASE
		WHEN (SELECT count(*) FROM `users` WHERE `role` = 'operator') = 1
			AND (SELECT `color_customized` FROM `workspace_settings` WHERE `id` = 'default') = 1
		THEN (SELECT `primary_color` FROM `workspace_settings` WHERE `id` = 'default')
		ELSE '#C81F68'
	END,
	CASE
		WHEN (SELECT count(*) FROM `users` WHERE `role` = 'operator') = 1
			AND (SELECT `color_customized` FROM `workspace_settings` WHERE `id` = 'default') = 1
		THEN 1
		ELSE 0
	END,
	`id`,
	CASE WHEN `status` = 'active' THEN 'active' ELSE 'disabled' END,
	`created_at`,
	`updated_at`
FROM `users`
WHERE `role` = 'operator';
--> statement-breakpoint
ALTER TABLE `events` ADD `client_id` text REFERENCES `clients`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `events_client_idx` ON `events` (`client_id`);
--> statement-breakpoint
UPDATE `events`
SET `client_id` = (
	SELECT `id` FROM `clients` WHERE `owner_user_id` = `events`.`created_by`
)
WHERE `created_by` IS NOT NULL;
