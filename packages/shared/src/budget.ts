/**
 * Task büdcəsinin default-ları və TƏTBİQ REJİMİ.
 *
 * Burada saxlanılır, `apps/server`-də yox: default rəqəm həm serverin fallback
 * məntiqində, həm də UI-ın "bu taskın limiti nədir?" yazısında lazımdır. İki
 * yerdə iki ədəd yazsaydıq, biri dəyişəndə istifadəçiyə YANLIŞ rəqəm
 * göstərilərdi — və bu, məhz gizli limitin yaratdığı problemin təkrarı olardı.
 */

/**
 * Limit aşılanda nə baş verir.
 *
 * - `'stop'` — icra kəsilir, sonrakılar başlamır. Avtomatik icralar (cədvəl,
 *   zəncir) üçün MƏCBURİDİR: orada baxan insan yoxdur və qaçmış xərc yalnız
 *   hesabda görünərdi (CLAUDE.md qayda 57).
 * - `'report'` — limit ÖLÇÜ vahididir, əyləc deyil: aşılsa da nə icra kəsilir,
 *   nə qalan alt-tasklar atılır. İstifadəçinin ƏL İLƏ göndərdiyi taskın
 *   default-u budur.
 *
 * NİYƏ `'report'` mümkündür — ÖLÇÜLMÜŞ SƏBƏB: `usage` hadisəsi HƏR runner-də
 * icranın SONUNDA gəlir (CLI parser-i onu yalnız `result` sətrindən emit edir
 * — qayda 3; API parser-i yalnız `finish`-dən — qayda 17). Yəni token/xərc
 * limitinin aşıldığını biz yalnız İŞ BİTDİKDƏN SONRA öyrənirik. O anda prosesi
 * öldürmək heç bir pul qazandırmır — yalnız ARTIQ ÖDƏNİLMİŞ nəticəni məhv edir.
 *
 * Real hadisə (2026-08-01, bölünmüş task): bir nüsxə 273 saniyə işləyib tam
 * cavab yazdı, `usage` gələndə 26,007 > 24,486 oldu və nəticə ATILDI. Ödəniş
 * qaldı, iş getdi.
 *
 * Vaxt limiti (`maxSeconds`) BUNDAN FƏRQLİDİR və hər rejimdə tətbiq olunur:
 * o, icra GEDƏRKƏN yoxlanılır, yəni ilişmiş prosesi həqiqətən dayandırır
 * (qayda 6 — ilişmiş `claude` prosesi token yandırmağa davam edir).
 */
export const BUDGET_ENFORCEMENTS = ['stop', 'report'] as const
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number]

/**
 * Yeni kontekstin default çıxış tokeni limiti.
 *
 * Əvvəlki dəyər UI-da SABİT KODLANMIŞ `30_000` idi və istifadəçi onu nə görə,
 * nə dəyişə bilirdi. Ölçülmüş: tək bir tam səhifəlik HTML generasiyası 26,007
 * çıxış tokeni yazır — yəni köhnə limit BİR icranı belə örtmürdü.
 */
export const DEFAULT_BUDGET_TOKENS = 200_000

/**
 * Default vaxt limiti — İCRA BAŞINA, task başına YOX.
 *
 * Bu, "task nə qədər çəkə bilər" sualının cavabı DEYİL (altı parçalı task
 * qanuni olaraq saatlarla çəkə bilər), "bir CLI prosesi nə vaxt ilişmiş sayılır"
 * sualının cavabıdır. Bir saatda bitməyən tək icra işləmir, ilişib.
 */
export const DEFAULT_BUDGET_SECONDS = 3_600
