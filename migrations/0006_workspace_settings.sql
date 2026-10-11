-- Identidad compartida del espacio (una sola fila) y tema personal por usuario.
-- Los binarios de logotipo no viven aqui: `logo_key` y `mark_key` apuntan a R2.
CREATE TABLE `workspace_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`name_customized` integer DEFAULT 0 NOT NULL,
	`description` text,
	`logo_key` text,
	`logo_content_type` text,
	`mark_key` text,
	`mark_content_type` text,
	`primary_color` text DEFAULT '#C81F68' NOT NULL,
	`color_customized` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workspace_settings_id_check" CHECK("workspace_settings"."id" = 'default'),
	CONSTRAINT "workspace_settings_name_check" CHECK(length("workspace_settings"."display_name") BETWEEN 1 AND 80),
	CONSTRAINT "workspace_settings_description_check" CHECK("workspace_settings"."description" IS NULL OR length("workspace_settings"."description") <= 280),
	CONSTRAINT "workspace_settings_color_check" CHECK("workspace_settings"."primary_color" GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'),
	CONSTRAINT "workspace_settings_name_flag_check" CHECK("workspace_settings"."name_customized" IN (0, 1)),
	CONSTRAINT "workspace_settings_color_flag_check" CHECK("workspace_settings"."color_customized" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_preferences_theme_check" CHECK("user_preferences"."theme" IN ('light', 'dark', 'system'))
);
