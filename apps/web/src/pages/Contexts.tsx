import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import BudgetPanel from '../components/BudgetPanel.js'
import CustomizationPanel from '../components/CustomizationPanel.js'
import FileAccessPanel from '../components/FileAccessPanel.js'
import FolderPicker from '../components/FolderPicker.js'
import { api } from '../lib/api.js'

export default function Contexts(): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  /**
   * Seçicinin hədəfi: `'new'` = yaratma formasının qovluğu, `<id>` = mövcud
   * kontekstin iş qovluğu, `null` = bağlı.
   *
   * TƏK state saxlanılır, hər sətrə ayrıca modal yox: eyni anda yalnız bir
   * seçici açıq ola bilər və N modal render etmək N `/api/fs/list` sorğusu
   * deməkdi.
   */
  const [picking, setPicking] = useState<string | null>(null)

  const { data } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })
  // Kataloq BİR dəfə çəkilir və bütün kontekstlərin paneli onu paylaşır —
  // kontekst başına sorğu N+1 olardı.
  const mcp = useQuery({ queryKey: ['mcp-servers'], queryFn: api.listMcpServers })
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.listPlugins })
  const selection = useQuery({
    queryKey: ['context-customizations'],
    queryFn: api.listContextCustomizations,
  })

  const create = useMutation({
    mutationFn: () =>
      api.createContext({
        name: name.trim(),
        ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
      }),
    onSuccess: () => {
      setName('')
      setCwd('')
      void qc.invalidateQueries({ queryKey: ['contexts'] })
    },
  })

  /**
   * Kontekst ayarlarının qismən yenilənməsi — paralellik, fayl icazəsi, iş
   * qovluğu. Hamısı BİR mutasiyadan keçir: server onsuz da yalnız verilən
   * sahəni dəyişir və hər ayar üçün ayrıca mutasiya eyni kodu təkrarlayardı.
   */
  const update = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof api.updateContext>[1] }) =>
      api.updateContext(input.id, input.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contexts'] })
      void qc.invalidateQueries({ queryKey: ['context-customizations'] })
    },
  })

  const pickedContextCwd =
    picking !== null && picking !== 'new'
      ? (data?.find((c) => c.id === picking)?.cwd ?? null)
      : null

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Kontekstlər</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Hər kontekst öz iş qovluğu, fayl icazəsi, büdcəsi və yoxlama əmrləri ilə ayrı iş
        sahəsidir.
      </p>

      <form
        className="mb-8 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() !== '') create.mutate()
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Ad
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Layihəm"
            className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          İş qovluğu (opsional)
          {/* Mətn sahəsi QALIR: yolu yapışdırmaq istəyən istifadəçi seçicidən
              keçməyə məcbur olmamalıdır. */}
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\Users\me\proj"
            className="w-72 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
          />
        </label>
        <button
          type="button"
          onClick={() => setPicking('new')}
          className="rounded border border-white/15 px-3 py-2 text-sm text-ink-dim hover:bg-white/5"
        >
          Seç…
        </button>
        <button
          type="submit"
          disabled={name.trim() === '' || create.isPending}
          className="rounded bg-accent/20 px-4 py-2 text-sm text-accent disabled:opacity-40"
        >
          {create.isPending ? 'Yaradılır…' : 'Yarat'}
        </button>
      </form>

      {create.error !== null && (
        <p className="mb-4 text-sm text-bad">{String(create.error)}</p>
      )}
      {update.error !== null && (
        <p className="mb-4 text-sm text-bad">{String(update.error)}</p>
      )}

      <ul className="space-y-2">
        {data?.map((c) => (
          <li key={c.id} className="rounded-lg border border-white/10 bg-surface-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{c.name}</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="truncate font-mono text-xs text-ink-dim">
                    {c.cwd ?? '(iş qovluğu yoxdur)'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPicking(c.id)}
                    className="shrink-0 text-xs text-accent hover:underline"
                  >
                    dəyiş
                  </button>
                </div>
                <div className="mt-1 text-xs text-ink-dim">
                  profil: {c.amplificationProfile} · işçi rejimi: {c.workerMode}
                </div>
              </div>
              <label className="flex flex-col gap-1 text-xs text-ink-dim">
                Paralel task
                <select
                  value={String(c.maxParallel)}
                  onChange={(e) =>
                    update.mutate({
                      id: c.id,
                      patch: { maxParallel: Number(e.target.value) },
                    })
                  }
                  className="rounded border border-white/15 bg-surface px-2 py-1 text-sm text-ink"
                >
                  {/* `0` = avtomatik: `min(4, nüvə-2)`. Sabit rəqəm default ola
                      bilməz, çünki cavab maşından asılıdır. */}
                  <option value="0">avtomatik</option>
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <BudgetPanel
              context={c}
              onSave={(patch) => update.mutate({ id: c.id, patch })}
            />

            <FileAccessPanel
              context={c}
              onSave={(patch) => update.mutate({ id: c.id, patch })}
            />

            <CustomizationPanel
              contextId={c.id}
              mcpServers={mcp.data?.servers ?? []}
              plugins={plugins.data?.plugins ?? []}
              selectedMcpIds={selection.data?.[c.id]?.mcpServerIds ?? []}
              selectedPluginIds={selection.data?.[c.id]?.pluginIds ?? []}
              builtinSkillsEnabled={c.builtinSkillsEnabled}
              onSave={(patch) => update.mutate({ id: c.id, patch })}
            />

            {c.cwd !== null && c.maxParallel !== 1 && (
              // İzolyasiya YALNIZ paralel kod tasklarında işə düşür — istifadəçi
              // "niyə mənim repoma birbaşa yazıldı?" sualının cavabını burada
              // görməlidir.
              <p className="mt-2 text-xs text-ink-dim">
                Paralel kod taskları ayrıca git worktree-də icra olunur; nəticə diff
                kimi göstərilir və repoya yalnız siz qəbul edəndə yazılır.
              </p>
            )}
          </li>
        ))}
      </ul>

      {data?.length === 0 && <p className="text-sm text-ink-dim">Hələ kontekst yoxdur.</p>}

      <FolderPicker
        open={picking !== null}
        {...(pickedContextCwd !== null ? { initialPath: pickedContextCwd } : {})}
        onClose={() => setPicking(null)}
        onSelect={(p) => {
          const target = picking
          setPicking(null)
          if (target === 'new') setCwd(p)
          else if (target !== null) update.mutate({ id: target, patch: { cwd: p } })
        }}
      />
    </div>
  )
}
