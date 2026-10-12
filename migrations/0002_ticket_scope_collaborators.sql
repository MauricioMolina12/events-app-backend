ALTER TABLE `events` ADD `registration_scope` text DEFAULT 'per_venue' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `ticket_design` text;--> statement-breakpoint
CREATE TABLE `collaborator_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`modules` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collaborator_groups_client_idx` ON `collaborator_groups` (`client_id`);--> statement-breakpoint
CREATE TABLE `collaborator_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `collaborator_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaborator_members_user_unique` ON `collaborator_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `collaborator_members_group_idx` ON `collaborator_members` (`group_id`);
