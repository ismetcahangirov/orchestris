import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api.js'

/** Pillələrin cari vəziyyəti — nə işləyir, nə hələ yoxdur. */
const RUNGS: { rung: number; name: string; cost: string; status: string }[] = [
  { rung: 0, name: 'Cache', cost: '0 token', status: 'işləyir' },
  { rung: 1, name: 'Qayda routing', cost: '0 token', status: 'işləyir' },
  { rung: 2, name: 'Zəif model + alət yoxlaması', cost: '0 token (yoxlama)', status: 'işləyir' },
  {
    rung: 3,
    name: 'Best-of-N + razılaşma',
    cost: 'işçi × 3, razılaşmasa × 5',
    status: 'işləyir',
  },
  { rung: 4, name: 'İpucu (shepherding)', cost: '—', status: 'Faza 2' },
  { rung: 5, name: 'Plan güclü / icra zəif', cost: '—', status: 'Faza 2' },
  { rung: 6, name: 'Self-escalation', cost: '~40 token müqavilə', status: 'işləyir' },
  { rung: 7, name: 'Tam güclü model', cost: '$$$', status: 'işləyir' },
]

const PROFILE_HINT: Record<string, string> = {
  cheap: 'Yalnız ən ucuz pillələr — eskalasiya yoxdur, nəticə həmişə işçinindir.',
  balanced:
    'Gündəlik iş üçün default. İşçi imtina edərsə və ya nüsxələr razılaşmazsa başçıya qalxır.',
  quality: 'Bütün mövcud pillələr — kritik işlər üçün (4 və 5 hələ tətbiq olunmayıb).',
  'boss-only': 'Baseline ölçməsi: keş və yoxlama söndürülür, hər task başçıya gedir.',
}

export default function LadderPage(): React.JSX.Element {
  const qc = useQueryClient()
  const [contextId, setContextId] = useState('')

  const { data: rules } = useQuery({ queryKey: ['routing-rules'], queryFn: api.getRoutingRules })
  const { data: contexts } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })

  const selected = contexts?.find((c) => c.id === contextId) ?? contexts?.[0]

  // Pillə dəstini server verir (`ladder.ts` → `activeRungs`). Burada təkrar
  // yazsaydıq iki həqiqət mənbəyi olardı və biri dəyişəndə səhifə yalan
  // danışardı — istifadəçi "aktiv" görüb, əslində işə düşməyən pilləyə
  // güvənərdi.
  const activeInProfile = new Set(
    rules?.profileRungs?.[selected?.amplificationProfile ?? 'balanced'] ?? [],
  )

  const setProfile = useMutation({
    mutationFn: (profile: string) =>
      api.updateContext(selected?.id ?? '', {
        amplificationProfile: profile as 'cheap' | 'balanced' | 'quality' | 'boss-only',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['contexts'] }),
  })

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Nərdivan</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Amplifikasiya pillələri və routing qaydaları. Hər pillə əvvəlkindən bahadır; task
        yalnız lazım olduqda yuxarı qalxır.
      </p>

      <section className="mb-6 rounded-lg border border-white/10 bg-surface-2 p-5">
        <h2 className="mb-3 text-sm font-semibold">Amplifikasiya profili</h2>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Kontekst
            <select
              value={selected?.id ?? ''}
              onChange={(e) => setContextId(e.target.value)}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            >
              {contexts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Amplifikasiya profili
            <select
              value={selected?.amplificationProfile ?? 'balanced'}
              onChange={(e) => setProfile.mutate(e.target.value)}
              disabled={selected === undefined}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            >
              {(rules?.profiles ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Bütün profillərin izahı göstərilir: istifadəçi seçim etməmişdən
            ƏVVƏL nəyi seçdiyini bilməlidir. */}
        <dl className="mt-3 space-y-1 text-xs">
          {(rules?.profiles ?? []).map((p) => (
            <div key={p} className="flex gap-2">
              <dt
                className={`w-24 shrink-0 font-mono ${
                  p === selected?.amplificationProfile ? 'text-accent' : 'text-ink-dim'
                }`}
              >
                {p}
              </dt>
              <dd className="text-ink-dim">{PROFILE_HINT[p] ?? ''}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mb-6 rounded-lg border border-white/10 bg-surface-2 p-5">
        <h2 className="mb-1 text-sm font-semibold">Pillələr</h2>
        <p className="mb-3 text-xs text-ink-dim">
          "Cari profildə" sütunu seçilmiş kontekstə görə hesablanır — hansı pillələrin bu
          taskda HƏQİQƏTƏN işə düşəcəyini göstərir.
        </p>
        <table className="w-full text-left text-xs">
          <thead className="text-ink-dim">
            <tr>
              <th className="pb-2">#</th>
              <th className="pb-2">Pillə</th>
              <th className="pb-2">Xərc</th>
              <th className="pb-2">Vəziyyət</th>
              <th className="pb-2">Cari profildə</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {RUNGS.map((r) => (
              <tr key={r.rung} className="border-t border-white/5">
                <td className="py-1.5">{r.rung}</td>
                <td className="py-1.5 font-sans">{r.name}</td>
                <td className="py-1.5">{r.cost}</td>
                <td className={`py-1.5 ${r.status === 'işləyir' ? 'text-good' : 'text-ink-dim'}`}>
                  {r.status}
                </td>
                <td
                  className={`py-1.5 ${activeInProfile.has(r.rung) ? 'text-accent' : 'text-ink-dim'}`}
                >
                  {activeInProfile.has(r.rung) ? 'aktiv' : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-white/10 bg-surface-2 p-5">
        <h2 className="mb-1 text-sm font-semibold">Routing qaydaları (Pillə 1)</h2>
        <p className="mb-3 text-xs text-ink-dim">
          Qaydalar hazırda kodda quraşdırılıb və bu səhifədən redaktə olunmur — redaktor
          sonrakı fazadadır. Sıra əhəmiyyətlidir: ilk uyğun gələn qayda qazanır.
        </p>
        <ul className="space-y-2">
          {(rules?.rules ?? []).map((r) => (
            <li key={r.id} className="border-t border-white/5 pt-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-ink">{r.id}</span>
                <span className="rounded bg-accent/15 px-2 py-0.5 text-accent">→ {r.prefer}</span>
              </div>
              <p className="mt-1 text-ink-dim">{r.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
