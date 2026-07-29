import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'

/**
 * Kataloqdan yeni provayder əlavə etmək (issue #44).
 *
 * NİYƏ SEÇİCİ, NİYƏ SƏRBƏST FORMA: ünvanı istifadəçidən istəsəydik, hər
 * provayder üçün onu doğru yazmaq onun işi olardı. ÖLÇÜLÜB (models.dev,
 * 2026-07-29): OpenAI-uyğun 138 provayderin HAMISININ ünvanı kataloqdadır —
 * yəni seçim + açar kifayətdir. Qiymətlər də oradan gəlir, ona görə qənaət
 * hesabı ilk gündən düzgün işləyir (qayda 4: qiyməti olmayan model üçün xərc
 * "bilinmir" qalır, `0` yazılmır).
 *
 * SİYAHI AVTOMATİK YAZILMIR: bütün ~138 provayderi `providers` cədvəlinə
 * səpsəydik, səhifə istifadəçinin heç vaxt işlətməyəcəyi sətirlərlə dolar və
 * "hansı biri mənimdir?" sualı yaranardı. Əlavə etmək AÇIQ seçimdir.
 */

/** Açar yazılan sahə açıq olduqda provayderin id-si; `null` = forma bağlıdır. */
type OpenFor = string | null

export default function AddProvider(): React.JSX.Element {
  const qc = useQueryClient()
  const [openFor, setOpenFor] = useState<OpenFor>(null)
  const [apiKey, setApiKey] = useState('')
  const [filter, setFilter] = useState('')

  const { data } = useQuery({
    queryKey: ['providers', 'available'],
    queryFn: api.availableProviders,
  })

  const add = useMutation({
    mutationFn: (v: { id: string; apiKey: string }) =>
      api.addProvider(v.id, v.apiKey === '' ? undefined : v.apiKey),
    onSettled: () => {
      // Açar state-dən DƏRHAL silinir — uğursuz halda da. React Query keşinə,
      // localStorage-a və ya URL-ə heç vaxt düşmür (qayda 13).
      setApiKey('')
    },
    onSuccess: () => {
      setOpenFor(null)
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['models'] })
    },
  })

  const all = data?.providers ?? []
  const needle = filter.trim().toLowerCase()
  // Süzgəc LAZIMDIR: kataloq yeniləndikdən sonra siyahıda ~138 provayder olur
  // və onları gözlə axtarmaq mümkün deyil.
  const shown = needle === '' ? all.slice(0, 8) : all.filter((p) => p.id.includes(needle))

  if (all.length === 0) return <></>

  return (
    <div className="mb-6 rounded-lg border border-white/10 bg-surface-2 p-4">
      <h2 className="mb-1 text-sm font-medium">Provayder əlavə et</h2>
      <p className="mb-3 text-xs text-ink-dim">
        Ünvan və model siyahısı models.dev kataloqundan gəlir — yalnız açar
        lazımdır. Lokal provayderlər (Ollama, LM Studio) açarsız da işləyir.
      </p>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Axtar (${all.length} provayder)…`}
        className="mb-3 w-full rounded border border-white/15 bg-surface px-3 py-1.5 text-sm text-ink"
      />

      <ul className="space-y-1">
        {shown.map((p) => (
          <li key={p.id} className="rounded border border-white/5 px-2 py-1.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{p.id}</span>
                <span className="text-ink-dim">{p.name}</span>
                <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-ink-dim">
                  {p.modelCount} model
                </span>
              </span>
              <button
                onClick={() => {
                  setOpenFor(openFor === p.id ? null : p.id)
                  setApiKey('')
                }}
                className="rounded bg-white/5 px-2 py-1 text-ink-dim hover:text-ink"
              >
                {openFor === p.id ? 'Ləğv et' : 'Əlavə et'}
              </button>
            </div>

            {openFor === p.id && (
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  add.mutate({ id: p.id, apiKey })
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="API açarı (lokal provayderdə boş buraxın)"
                  className="w-72 rounded border border-white/15 bg-surface px-2 py-1 font-mono text-ink"
                />
                <button
                  type="submit"
                  disabled={add.isPending}
                  className="rounded bg-accent/20 px-3 py-1 text-accent disabled:opacity-40"
                >
                  {add.isPending ? 'Əlavə olunur…' : 'Təsdiqlə'}
                </button>
                {/* Açarı harada tapmaq lazımdır — models.dev bildirir. */}
                {p.envVars.length > 0 && (
                  <span className="text-ink-dim">env: {p.envVars.join(', ')}</span>
                )}
                {p.doc !== undefined && (
                  <a href={p.doc} target="_blank" rel="noreferrer" className="text-ink-dim underline">
                    sənəd
                  </a>
                )}
              </form>
            )}
          </li>
        ))}
      </ul>

      {needle === '' && all.length > shown.length && (
        <p className="mt-2 text-xs text-ink-dim">
          …və {all.length - shown.length} provayder daha — axtarışdan istifadə edin.
        </p>
      )}
      {needle !== '' && shown.length === 0 && (
        <p className="mt-2 text-xs text-ink-dim">Uyğun provayder tapılmadı.</p>
      )}

      {add.error !== null && (
        <p className="mt-2 rounded bg-bad/10 p-2 text-xs text-bad">{String(add.error)}</p>
      )}
    </div>
  )
}
