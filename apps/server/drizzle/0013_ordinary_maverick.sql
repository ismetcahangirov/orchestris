ALTER TABLE `tasks` ADD `status_reason` text;--> statement-breakpoint
-- ƏL İLƏ ƏLAVƏ EDİLİB (drizzle-kit yalnız sxem fərqini yazır).
--
-- `budget_tokens` / `budget_seconds` bu vaxta qədər HƏMİŞƏ NULL idi: onları
-- təyin etmək üçün nə UI, nə də praktikada işlədilən API yolu var idi — faktiki
-- limit web klientində SABİT KODLANMIŞDI (30,000 token / 600 s). Yəni bazadakı
-- NULL istifadəçinin "limitsiz" seçimi DEYİL, sadəcə ayarın mövcud olmamasıdır.
--
-- İndi NULL məhz "limitsiz" mənasını daşıyır (istifadəçi sahəni boşalda bilər).
-- Köhnə sətirləri olduğu kimi saxlasaydıq, bütün mövcud kontekstlər bir gecədə
-- limitsizə keçərdi — halbuki onlar heç vaxt belə seçim etməyib. Miqrasiya
-- 0002-nin (`max_parallel = 1` → `0`) eyni mühakiməsi: seçilməmiş default-u
-- dəyişmək olar, işləyən seçimi yox.
UPDATE `contexts` SET `budget_tokens` = 200000 WHERE `budget_tokens` IS NULL;--> statement-breakpoint
UPDATE `contexts` SET `budget_seconds` = 3600 WHERE `budget_seconds` IS NULL;
