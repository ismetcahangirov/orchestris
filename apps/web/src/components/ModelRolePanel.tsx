import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { selectableModels, type SelectableModel } from '../lib/selectableModels.js'

/**
 * Başçı və işçi modelinin seçimi — idarə panelində.
 *
 * NİYƏ BURADA, HALBUKİ `/providers`-də ONSUZ DA VAR: orada rol hər provayderin
 * öz siyahısının içindədir, yəni "başçım kimdir?" sualına cavab almaq üçün
 * provayderləri bir-bir açmaq lazımdır. Bu iki seçim isə sistemin ƏSAS
 * ayarlarıdır — nərdivanın 7-ci pilləsi başçını, 2-ci pilləsi işçini işlədir.
 * `/providers` səhifəsi SİLİNMİR: orada modelin bütün detalları (qiymət,
 * kontekst, qabiliyyət) və çoxlu işçi seçimi qalır.
 *
 * ABUNƏLİK VƏ API BİR SİYAHIDA — və bu, sadəcə rahatlıq deyil: CLI runner-ləri
 * `providers` cədvəlində `kind: 'cli'` ilə oturur (qayda 21) məhz ona görə ki,
 * Auto onların modellərini namizəd görsün. Seçicidə də eyni məntiq işləməlidir,
 * yoxsa istifadəçi "niyə başçı kimi `cli:claude` seçə bilmirəm?" sualı ilə
 * qarşılaşardı. Fərq GİZLƏDİLMİR, ETİKETLƏNİR: abunəlik icrasında kartdan pul
 * çıxmır, API-da çıxır (qayda 5) — və bu, seçimin ən vacib nəticəsidir.
 */

/** Provayder üzrə qruplaşdırır — `<optgroup>` seçicini oxunaqlı edir. */
function groupByProvider(options: readonly SelectableModel[]): [string, SelectableModel[]][] {
  const groups = new Map<string, SelectableModel[]>()
  for (const o of options) {
    const list = groups.get(o.providerLabel)
    if (list === undefined) groups.set(o.providerLabel, [o])
    else list.push(o)
  }
  // Abunəlik ƏVVƏLDƏ: layihənin bütün məqsədi ucuz yolu default etməkdir
  // (qayda 5 — abunəlik icrasında kartdan pul çıxmır).
  return [...groups.entries()].sort(([a], [b]) => {
    const aSub = a.includes('abunəlik') ? 0 : 1
    const bSub = b.includes('abunəlik') ? 0 : 1
    return aSub - bSub || a.localeCompare(b)
  })
}

function RoleSelect({
  label,
  hint,
  options,
  selectedId,
  onSelect,
  busy,
}: {
  label: string
  hint: string
  options: SelectableModel[]
  selectedId: string | undefined
  onSelect: (modelRowId: string) => void
  busy: boolean
}): React.JSX.Element {
  const chosen = options.find((o) => o.model.id === selectedId)

  return (
    <label className="flex flex-col gap-1 text-xs text-ink-dim">
      <span>
        {label}
        <span className="ml-1 text-ink-dim/70">{hint}</span>
      </span>
      <select
        value={selectedId ?? ''}
        disabled={busy}
        onChange={(e) => {
          if (e.target.value !== '') onSelect(e.target.value)
        }}
        className="w-72 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink disabled:opacity-50"
      >
        <option value="">— seçilməyib —</option>
        {groupByProvider(options).map(([provider, list]) => (
          <optgroup key={provider} label={provider}>
            {list.map((o) => (
              <option key={o.model.id} value={o.model.id}>
                {o.model.modelId}
                {o.ready ? '' : ' (hazır deyil)'}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {/* Seçilmiş model hazır deyilsə səbəb DƏRHAL görünür — yoxsa istifadəçi
          bunu yalnız task sınandan sonra bilərdi. */}
      {chosen !== undefined && !chosen.ready && (
        <span className="text-warn">
          {chosen.runnerId} hazır deyil — /providers səhifəsindən qur
        </span>
      )}
    </label>
  )
}

export default function ModelRolePanel(): React.JSX.Element {
  const qc = useQueryClient()
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: () => api.listModels() })
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders })

  const setRole = useMutation({
    mutationFn: (v: { id: string; role: 'boss' | 'worker'; exclusive: boolean }) =>
      api.setModelRole(v.id, v.role, true, v.exclusive),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['models'] }),
  })

  const options = selectableModels(models ?? [], providers)
  const boss = options.find((o) => o.model.roleBoss)
  const workers = options.filter((o) => o.model.roleWorker)

  return (
    <section className="mb-6 rounded-lg border border-white/10 bg-surface-2 p-5">
      <h2 className="mb-1 text-sm font-medium">Modellər</h2>
      <p className="mb-4 text-xs text-ink-dim">
        Başçı nərdivanın son pilləsində (7) işlədilir, işçi isə bütün adi
        icralarda. Siyahıda həm abunəlik (CLI), həm API modelləri var.
      </p>

      <div className="flex flex-wrap gap-4">
        <RoleSelect
          label="Başçı model"
          hint="— son çarə, ən bahalı"
          options={options}
          selectedId={boss?.model.id}
          onSelect={(id) => setRole.mutate({ id, role: 'boss', exclusive: false })}
          busy={setRole.isPending}
        />
        <RoleSelect
          label="İşçi model"
          hint="— gündəlik icra"
          options={options}
          selectedId={workers[0]?.model.id}
          onSelect={(id) => setRole.mutate({ id, role: 'worker', exclusive: true })}
          busy={setRole.isPending}
        />
      </div>

      {/* Çoxlu işçi QANUNİDİR (Auto onların içindən seçir), amma dropdown tək
          seçim deməkdir. Buradan seçmək qalanlarını söndürür — bunu gizlətmək
          istifadəçinin `/providers`-də qurduğu konfiqurasiyanı səssizcə
          dağıtmaq olardı. */}
      {workers.length > 1 && (
        <p className="mt-3 rounded bg-warn/10 p-2 text-xs text-warn">
          Hazırda {workers.length} işçi model seçilib (Auto onların içindən
          seçir). Buradan bir model seçsəniz, qalanlarının işçi rolu alınacaq —
          çoxlu işçi üçün /providers səhifəsini işlədin.
        </p>
      )}

      {options.length === 0 && (
        <p className="text-xs text-warn">
          Seçilə bilən model yoxdur — /providers səhifəsindən provayder qurun.
        </p>
      )}

      {setRole.error !== null && (
        <p className="mt-3 text-xs text-bad">{String(setRole.error)}</p>
      )}
    </section>
  )
}
