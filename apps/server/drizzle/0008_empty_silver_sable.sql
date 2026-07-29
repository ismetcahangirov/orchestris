ALTER TABLE `schedules` ADD `max_pending_diffs` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `schedule_id` text;