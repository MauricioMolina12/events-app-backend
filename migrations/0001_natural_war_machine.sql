CREATE TABLE `registration_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`participation_id` text NOT NULL,
	`registration_id` text NOT NULL,
	`role` text NOT NULL,
	`document_type` text NOT NULL,
	`document_number` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`released_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participation_id`) REFERENCES `event_establishments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`registration_id`) REFERENCES `registrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_documents_event_document_unique` ON `registration_documents` (`event_id`,`document_type`,`document_number`) WHERE "registration_documents"."status" = 'active';--> statement-breakpoint
CREATE INDEX `registration_documents_registration_idx` ON `registration_documents` (`registration_id`);--> statement-breakpoint
CREATE INDEX `registration_documents_participation_status_idx` ON `registration_documents` (`participation_id`,`status`);--> statement-breakpoint
CREATE INDEX `registration_documents_document_idx` ON `registration_documents` (`document_type`,`document_number`);