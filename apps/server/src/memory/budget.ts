import type { MemoryItem } from './provider.js'

/**
 * Kontekst şişməsinə qarşı qoruma — yaddaşın TOKEN büdcəsi.
 *
 * Bu modul saf funksiyalardan ibarətdir və **0 token** xərcləyir.
 */

/**
 * Bir icraya əlavə oluna bilən yaddaşın yuxarı həddi (token).
 *
 * Rəqəm KONTEKSTƏ görə ayarlanmır və bu, qəsdəndir: hər knob istifadəçidən
 * ölçmə tələb edir, halbuki hələ heç bir real ölçmə yoxdur (bax "Bilinən
 * boşluqlar"). Sabit hədd isə ən pis halı bilinən saxlayır.
 *
 * 600 seçildi, çünki CLI icrasının prompt döşəməsi ölçülmüş ~21.7k tokendir
 * (qayda 1) — 600 onun ~3%-idir. Yaddaş faydalı olsa belə, bir icranın
 * prompt xərcini nəzərəçarpacaq artırmamalıdır: artırsa, o tokenlər ƏBƏDİ
 * vergiyə çevrilir (eyni məntiq: qayda 39, uzun şablon).
 */
export const MEMORY_TOKEN_BUDGET = 600

/**
 * Simvol → token nisbəti.
 *
 * `4` (ingiliscə üçün adi təxmin) İŞLƏDİLMİR: bu layihənin promptları
 * Azərbaycan dilindədir və Azərbaycan mətni tokenləşdiricidə daha pis
 * sıxılır (ə, ü, ö, ş, ç, ğ, ı hərfləri çox vaxt ayrıca token olur). `4`
 * götürsəydik büdcə SƏSSİZCƏ aşılardı — təxminimiz həqiqi tokendən az
 * göstərərdi.
 *
 * `3` təxmini YUXARI qiymətləndirir: səhv etsək az yaddaş qatılır, çox yox.
 * Səhvin ucuz istiqaməti budur.
 */
export const CHARS_PER_TOKEN = 3

/** Mətnin təxmini token sayı — həmişə ≥ 1 (boş sətir də ayırıcı yeyir). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

/**
 * Qeydləri büdcəyə sığdırır.
 *
 * Kəsim RELEVANTLIĞA görədir (spesifikasiya §9): `score` böyük olan qalır.
 * Sıraya görə kəssəydik, provayderin qaytardığı təsadüfi sıra büdcənin
 * kimə çatacağını həll edərdi.
 *
 * Sığmayan qeyd ATILIR, amma dövrə DAYANMIR: ondan sonra gələn kiçik qeyd
 * hələ sığa bilər. Dayansaydıq, bir uzun qeyd qalan bütün büdcəni israf
 * edərdi.
 *
 * Qeydin MƏTNİ heç vaxt kəsilmir — yarımçıq cümlə yanıldıcıdır və modelin
 * onu necə oxuyacağı bilinmir (eyni prinsip: qayda 39).
 */
export function trimToBudget(
  items: readonly MemoryItem[],
  tokenBudget: number,
): MemoryItem[] {
  if (tokenBudget <= 0) return []

  const ranked = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const kept: MemoryItem[] = []
  let used = 0

  for (const item of ranked) {
    const cost = estimateTokens(item.text)
    if (used + cost > tokenBudget) continue
    kept.push(item)
    used += cost
  }

  return kept
}
