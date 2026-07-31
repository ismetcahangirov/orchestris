import { useState } from 'react'
import type { QuestionRow } from '../lib/api.js'

interface Props {
  question: QuestionRow
  onAnswer: (answer: boolean | string | string[]) => void
  /** Göndəriş gedərkən düymələr sönükdür — ikiqat cavab 409 alardı. */
  pending?: boolean
}

function renderAnswer(question: QuestionRow): string {
  if (question.status === 'cancelled') return '(ləğv edildi)'
  if (question.answerJson === null) return '(cavab yoxdur)'
  const answer: unknown = JSON.parse(question.answerJson)
  if (Array.isArray(answer)) return answer.join(', ')
  if (typeof answer === 'boolean') return answer ? 'bəli' : 'xeyr'
  return String(answer)
}

/**
 * İşçinin sualı (Faza 5B).
 *
 * Üç forma BİR komponentdədir: `yes_no` → iki düymə, `single` → radio,
 * `multi` → checkbox. Ayrı komponentlərə bölsəydik üçü də eyni "cavablanmış
 * sual" görünüşünü təkrarlayardı.
 */
export default function QuestionPanel({
  question,
  onAnswer,
  pending,
}: Props): React.JSX.Element {
  const [single, setSingle] = useState('')
  const [multi, setMulti] = useState<string[]>([])

  if (question.status !== 'pending') {
    return (
      <div className="rounded border border-white/10 bg-surface-2 p-3 text-sm">
        <div className="text-ink-dim">{question.question}</div>
        <div className="mt-1">{renderAnswer(question)}</div>
      </div>
    )
  }

  return (
    <div className="rounded border border-accent/40 bg-accent/5 p-3">
      <div className="mb-2 text-sm font-medium">{question.question}</div>

      {question.kind === 'yes_no' && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => onAnswer(true)}
            className="rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Bəli
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onAnswer(false)}
            className="rounded border border-white/15 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Xeyr
          </button>
        </div>
      )}

      {question.kind === 'single' && (
        <>
          {question.options.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`q-${question.id}`}
                aria-label={o}
                checked={single === o}
                onChange={() => setSingle(o)}
              />
              {o}
            </label>
          ))}
          <button
            type="button"
            disabled={pending === true || single === ''}
            onClick={() => onAnswer(single)}
            className="mt-2 rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Göndər
          </button>
        </>
      )}

      {question.kind === 'multi' && (
        <>
          {question.options.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={o}
                checked={multi.includes(o)}
                onChange={(e) =>
                  setMulti((prev) =>
                    e.target.checked ? [...prev, o] : prev.filter((x) => x !== o),
                  )
                }
              />
              {o}
            </label>
          ))}
          {/*
            Boş seçimlə göndərmək OLMAZ: həm zod sxemi, həm server onu rədd edir
            və istifadəçi səbəbsiz xəta görərdi.
          */}
          <button
            type="button"
            disabled={pending === true || multi.length === 0}
            onClick={() => onAnswer(multi)}
            className="mt-2 rounded bg-accent px-3 py-1.5 text-sm text-black disabled:opacity-40"
          >
            Göndər
          </button>
        </>
      )}
    </div>
  )
}
