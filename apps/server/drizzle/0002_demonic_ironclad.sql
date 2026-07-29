CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`kind` text DEFAULT 'diff' NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`repo_path` text NOT NULL,
	`content` text NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_task_kind_idx` ON `artifacts` (`task_id`,`kind`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cwd` text,
	`amplification_profile` text DEFAULT 'balanced' NOT NULL,
	`worker_mode` text DEFAULT 'auto' NOT NULL,
	`auto_submode` text DEFAULT 'cheap' NOT NULL,
	`default_worker_model_id` text,
	`verify_commands_json` text DEFAULT '[]' NOT NULL,
	`budget_tokens` integer,
	`budget_usd` real,
	`budget_seconds` integer,
	`max_parallel` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_contexts`("id", "name", "cwd", "amplification_profile", "worker_mode", "auto_submode", "default_worker_model_id", "verify_commands_json", "budget_tokens", "budget_usd", "budget_seconds", "max_parallel", "created_at", "archived_at") SELECT "id", "name", "cwd", "amplification_profile", "worker_mode", "auto_submode", "default_worker_model_id", "verify_commands_json", "budget_tokens", "budget_usd", "budget_seconds", "max_parallel", "created_at", "archived_at" FROM `contexts`;--> statement-breakpoint
DROP TABLE `contexts`;--> statement-breakpoint
ALTER TABLE `__new_contexts` RENAME TO `contexts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- ƏL İLƏ ƏLAVƏ EDİLİB (drizzle-kit yalnız sxem fərqini yazır).
-- Köhnə default `1` idi və onu DƏYİŞMƏK ÜÇÜN API ÜMUMİYYƏTLƏ YOX İDİ — yəni
-- bazadakı hər `1` istifadəçinin seçimi deyil, məhz köhnə default-dur. Olduğu
-- kimi saxlasaydıq, mövcud bütün kontekstlərdə paralellik əbədi söndürülü
-- qalardı və yeni ayarın default-u (`0` = avtomatik) heç vaxt işə düşməzdi.
UPDATE `contexts` SET `max_parallel` = 0 WHERE `max_parallel` = 1;