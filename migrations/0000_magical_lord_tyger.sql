CREATE TABLE `auth_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`succeeded` integer NOT NULL,
	`source_hash` text,
	`attempted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_identifier_time_idx` ON `auth_attempts` (`identifier`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`full_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_iterations` integer NOT NULL,
	`role` text DEFAULT 'operator' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_login_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE TABLE `establishments` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`city` text,
	`address` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `establishments_code_unique` ON `establishments` (`code`);--> statement-breakpoint
CREATE INDEX `establishments_status_idx` ON `establishments` (`status`);--> statement-breakpoint
CREATE TABLE `event_establishments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`establishment_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`titular_capacity` integer DEFAULT 0 NOT NULL,
	`companion_capacity` integer DEFAULT 0 NOT NULL,
	`confirmed_titulares` integer DEFAULT 0 NOT NULL,
	`confirmed_companions` integer DEFAULT 0 NOT NULL,
	`registration_opens_at` integer,
	`registration_closes_at` integer,
	`check_in_opens_at` integer,
	`check_in_closes_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`establishment_id`) REFERENCES `establishments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "event_establishments_titular_capacity_check" CHECK("event_establishments"."confirmed_titulares" >= 0 AND "event_establishments"."confirmed_titulares" <= "event_establishments"."titular_capacity"),
	CONSTRAINT "event_establishments_companion_capacity_check" CHECK("event_establishments"."confirmed_companions" >= 0 AND "event_establishments"."confirmed_companions" <= "event_establishments"."companion_capacity"),
	CONSTRAINT "event_establishments_registration_window_check" CHECK("event_establishments"."registration_opens_at" IS NULL OR "event_establishments"."registration_closes_at" IS NULL OR "event_establishments"."registration_opens_at" <= "event_establishments"."registration_closes_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_establishments_event_establishment_unique` ON `event_establishments` (`event_id`,`establishment_id`);--> statement-breakpoint
CREATE INDEX `event_establishments_event_idx` ON `event_establishments` (`event_id`);--> statement-breakpoint
CREATE INDEX `event_establishments_establishment_idx` ON `event_establishments` (`establishment_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`timezone` text DEFAULT 'America/Bogota' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`registration_opens_at` integer,
	`registration_closes_at` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "events_window_check" CHECK("events"."registration_opens_at" IS NULL OR "events"."registration_closes_at" IS NULL OR "events"."registration_opens_at" <= "events"."registration_closes_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE INDEX `events_status_idx` ON `events` (`status`);--> statement-breakpoint
CREATE TABLE `registration_companions` (
	`id` text PRIMARY KEY NOT NULL,
	`registration_id` text NOT NULL,
	`full_name` text NOT NULL,
	`document_type` text,
	`document_number` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`registration_id`) REFERENCES `registrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `registration_companions_registration_idx` ON `registration_companions` (`registration_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `registration_companions_document_unique` ON `registration_companions` (`registration_id`,`document_type`,`document_number`) WHERE "registration_companions"."document_number" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`participation_id` text NOT NULL,
	`document_type` text NOT NULL,
	`document_number` text NOT NULL,
	`full_name` text NOT NULL,
	`email` text,
	`phone` text,
	`companions_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source` text DEFAULT 'public' NOT NULL,
	`registered_at` integer NOT NULL,
	`cancelled_at` integer,
	`cancelled_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`participation_id`) REFERENCES `event_establishments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "registrations_companions_count_check" CHECK("registrations"."companions_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registrations_participation_document_unique` ON `registrations` (`participation_id`,`document_type`,`document_number`) WHERE "registrations"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX `registrations_participation_status_idx` ON `registrations` (`participation_id`,`status`);--> statement-breakpoint
CREATE INDEX `registrations_document_idx` ON `registrations` (`document_type`,`document_number`);--> statement-breakpoint
CREATE TABLE `qr_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`registration_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` integer NOT NULL,
	`issued_by` text,
	`revoked_at` integer,
	`revoked_by` text,
	`revoked_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`registration_id`) REFERENCES `registrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qr_codes_token_hash_unique` ON `qr_codes` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `qr_codes_active_per_registration_unique` ON `qr_codes` (`registration_id`) WHERE "qr_codes"."status" = 'active';--> statement-breakpoint
CREATE INDEX `qr_codes_registration_idx` ON `qr_codes` (`registration_id`);--> statement-breakpoint
CREATE TABLE `qr_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`qr_code_id` text NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider` text,
	`attempted_at` integer NOT NULL,
	`sent_at` integer,
	`error_message` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`qr_code_id`) REFERENCES `qr_codes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `qr_deliveries_qr_code_idx` ON `qr_deliveries` (`qr_code_id`);--> statement-breakpoint
CREATE INDEX `qr_deliveries_status_attempted_idx` ON `qr_deliveries` (`status`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `shift_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_id` text NOT NULL,
	`registration_id` text NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`assigned_at` integer NOT NULL,
	`assigned_by` text,
	`checked_in_at` integer,
	`checked_in_by` text,
	`released_at` integer,
	`release_reason` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`registration_id`) REFERENCES `registrations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`checked_in_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shift_assignments_registration_active_unique` ON `shift_assignments` (`registration_id`) WHERE "shift_assignments"."status" IN ('assigned', 'checked_in');--> statement-breakpoint
CREATE INDEX `shift_assignments_shift_status_idx` ON `shift_assignments` (`shift_id`,`status`);--> statement-breakpoint
CREATE INDEX `shift_assignments_registration_idx` ON `shift_assignments` (`registration_id`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`participation_id` text NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`capacity` integer NOT NULL,
	`assigned_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`participation_id`) REFERENCES `event_establishments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shifts_assigned_count_check" CHECK("shifts"."assigned_count" >= 0 AND "shifts"."assigned_count" <= "shifts"."capacity"),
	CONSTRAINT "shifts_window_check" CHECK("shifts"."starts_at" <= "shifts"."ends_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shifts_participation_code_unique` ON `shifts` (`participation_id`,`code`);--> statement-breakpoint
CREATE INDEX `shifts_participation_starts_idx` ON `shifts` (`participation_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `shifts_status_idx` ON `shifts` (`status`);--> statement-breakpoint
CREATE TABLE `capacity_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`participation_id` text NOT NULL,
	`titular_capacity_from` integer NOT NULL,
	`titular_capacity_to` integer NOT NULL,
	`companion_capacity_from` integer NOT NULL,
	`companion_capacity_to` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`resolved_by` text,
	`resolved_at` integer,
	`resolution_notes` text,
	`applied_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`participation_id`) REFERENCES `event_establishments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "capacity_adjustments_targets_check" CHECK("capacity_adjustments"."titular_capacity_to" >= 0 AND "capacity_adjustments"."companion_capacity_to" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capacity_adjustments_participation_pending_unique` ON `capacity_adjustments` (`participation_id`) WHERE "capacity_adjustments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `capacity_adjustments_participation_status_idx` ON `capacity_adjustments` (`participation_id`,`status`);--> statement-breakpoint
CREATE INDEX `capacity_adjustments_status_created_idx` ON `capacity_adjustments` (`status`,`created_at`);