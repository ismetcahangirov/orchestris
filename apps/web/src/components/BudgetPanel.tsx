import { useState } from 'react'
import { parseBudgetForm, type BudgetPatch } from '../lib/budgetLabel.js'

export interface BudgetContext {
  id: string
  budgetTokens: number | null
  budgetUsd: number | null
  budgetSeconds: number | null
}

interface Props {
  context: BudgetContext
  onSave: (patch: BudgetPatch) => void
}

const show = (n: number | null): string => (n === null ? '' : String(n))

/**
 * Kontekstin task büdcəsi.
 *
 * NİYƏ BURADADIR: əvvəl bu üç rəqəm ÜMUMİYYƏTLƏ redaktə edilə bilmirdi — web
 * klienti hər taska sabit `30_000` token və `600` saniyə yazırdı. Sütunlar
 * bazada ilk gündən var idi, sadəcə onlara toxunan yol yox idi.
 *
 * Dəyişikliklər ANİ göndərilmir (fayl icazəsi panelindən fərqli olaraq): rəqəm
 * sahəsində hər klaviatura vuruşu ayrıca PATCH olardı və `2` yazarkən limit bir
 * anlıq həqiqətən `2`-yə düşərdi.
 */
export default function BudgetPanel({ context, onSave }: Props): React.JSX.Element {
  const [tokens, setTokens] = useState(show(context.budgetTokens))
  const [usd, setUsd] = useState(show(context.budgetUsd))
  const [minutes, setMinutes] = useState(
    context.budgetSeconds === null ? '' : String(context.budgetSeconds / 60),
  )
  const [error, setError] = useState<string | null>(null)

  const dirty =
    tokens !== show(context.budgetTokens) ||
    usd !== show(context.budgetUsd) ||
    minutes !== (context.budgetSeconds === null ? '' : String(context.budgetSeconds / 60))

  const save = (): void => {
    const parsed = parseBudgetForm({ tokens, usd, minutes })
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    setError(null)
    onSave(parsed.patch)
  }

  return (
    <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
      <div className="text-xs font-medium text-ink-dim">Task büdcəsi</div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Çıxış tokeni
          <input
            aria-label="Çıxış tokeni limiti"
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
            placeholder="limitsiz"
            className="w-32 rounded border border-white/15 bg-surface px-2 py-1 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Xərc ($)
          <input
            aria-label="Xərc limiti"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
            placeholder="limitsiz"
            className="w-24 rounded border border-white/15 bg-surface px-2 py-1 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          İcra başına vaxt (dəq)
          <input
            aria-label="İcra başına vaxt limiti"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="limitsiz"
            className="w-32 rounded border border-white/15 bg-surface px-2 py-1 text-sm text-ink"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={!dirty}
          className="self-end rounded border border-white/15 px-3 py-1 text-sm text-ink-dim hover:bg-white/5 disabled:opacity-40"
        >
          Yadda saxla
        </button>
      </div>

      {error !== null && <p className="text-xs text-bad">{error}</p>}

      <p className="text-xs text-ink-dim/70">
        Boş sahə = limitsiz. Token və xərc limiti taskı DAYANDIRMIR — aşım yalnız
        qeyd olunur, çünki sərfiyyat yalnız icra bitəndən sonra bilinir və o anda
        kəsmək ödənilmiş nəticəni atmaqdan başqa heç nə etmir. Vaxt limiti isə
        həqiqətən kəsir: ilişmiş icranı yalnız o dayandıra bilir. Bölünmüş taskda
        hər parça limiti TAM alır.
      </p>
    </div>
  )
}
