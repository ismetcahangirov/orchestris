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

## Vəziyyət

Faza 1A tamamlandı: icra qatı, CLI parser-ləri, SQLite hadisə jurnalı,
REST + WebSocket, 4 səhifəli UI. Bütün testlər (233) real CLI fixture-ləri
üzərində işləyir və heç bir token xərcləmir.
