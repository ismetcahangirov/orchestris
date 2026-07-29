# orchestris

Lokal AI orkestrasiya sistemi — zəif/ucuz modellərdən güclü model performansı.

Sənin lokal CLI abunəliklərindən (`claude`, `codex`) istifadə edir, hər taskı
canlı izləməyə imkan verir və token xərcini ölçür.

- Dizayn: [`docs/superpowers/specs/2026-07-26-orchestris-design.md`](docs/superpowers/specs/2026-07-26-orchestris-design.md)
- Faza 1A planı: [`docs/superpowers/plans/2026-07-26-faza1a-temel-icra-qati.md`](docs/superpowers/plans/2026-07-26-faza1a-temel-icra-qati.md)
- İşçi təlimatı: [`CLAUDE.md`](CLAUDE.md)

## Başlamaq

```bash
pnpm install
pnpm test                                  # sıfır token xərcləyir
pnpm --filter @orchestris/server dev       # http://127.0.0.1:4319
pnpm --filter @orchestris/web dev          # http://localhost:5319
```

Brauzerdə `http://localhost:5319` aç:

1. **Provayderlər** — hansı CLI-ların hazır olduğunu göstərir
2. **Kontekstlər** — iş sahəsi yarat
3. **İdarə paneli** — task işə sal
4. Task səhifəsi — canlı hadisə axını, token və xərc

`cli:codex` istifadə etmək üçün bir dəfə `codex login` lazımdır.

## Yaddaş (opsional, Faza 3)

Yaddaş **default olaraq söndürülüdür** — taskların mətnini xarici anbara yazmaq
istifadəçinin açıq qərarıdır. Açmaq üçün:

```bash
ORCHESTRIS_MEMORY=claude-mem                 # provayder (yeganə seçim)
ORCHESTRIS_CLAUDE_MEM_MIN_VERSION=<versiya>  # MƏCBURİ — bax CLAUDE.md qayda 50
ORCHESTRIS_CLAUDE_MEM_URL=http://127.0.0.1:37777   # opsional
ORCHESTRIS_MEMORY_WRITE_COST_USD=0           # opsional: pulsuz model bəyanı
```

Minimum versiya verilməsə yaddaş qoşulmur (fail-closed) və səbəb `/ladder`
səhifəsində göstərilir. Hər kontekst yaddaşı ayrıca söndürə bilər.

## Vəziyyət

Faza 1A–3 tamamlandı: icra qatı və CLI parser-ləri, API açarları + model
kəşfi, amplifikasiya nərdivanının bütün pillələri (0–7), prompt distilləsi,
paralel icra + worktree izolyasiyası, yaddaş adapteri. Bütün testlər real CLI
fixture-ləri və `FakeRunner` üzərində işləyir, heç bir token xərcləmir.
