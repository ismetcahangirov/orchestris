import { WorkflowSteps, type WorkflowStep } from '@orchestris/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import WorkflowRunPanel from '../components/WorkflowRunPanel.js'
import SchedulePanel from '../components/SchedulePanel.js'
import StepList from '../components/StepList.js'
import { api, type WorkflowRow } from '../lib/api.js'

/**
 * Nümunə zəncir — boş redaktor istifadəçini "nə yazım?" sualı ilə tək qoyardı.
 *
 * Qəsdən HƏR ÜÇ mexanizmi göstərir: dəyişən əvəzlənməsi, şərtli budaqlanma və
 * `continueOnError` — çünki üçü birlikdə işləməsə zəncir sadəcə ardıcıl task
 * siyahısıdır.
 */
const SAMPLE: WorkflowStep[] = [
  { kind: 'task', id: 'yaz', prompt: 'README üçün giriş abzası yaz', continueOnError: true },
  {
    kind: 'task',
    id: 'yoxla',
    prompt: 'Bu mətndə faktiki səhv varmı? Varsa düzəlt:\n\n{{previous}}',
    when: { from: 'yaz', test: 'succeeded' },
  },
]

function parseSteps(text: string): { steps: WorkflowStep[] } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { error: `JSON oxunmadı: ${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = WorkflowSteps.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      error: `${first?.path.join('.') ?? ''}: ${first?.message ?? 'yararsız addım'}`,
    }
  }
  return { steps: parsed.data }
}

export default function Workflows(): React.JSX.Element {
  const qc = useQueryClient()
  const [contextId, setContextId] = useState('')
  const [name, setName] = useState('')
  const [stepsText, setStepsText] = useState(JSON.stringify(SAMPLE, null, 2))
  const [openId, setOpenId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)

  const { data: contexts } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })
  const { data } = useQuery({ queryKey: ['workflows'], queryFn: api.listWorkflows })

  // Validasiya UI-da DA edilir, serverdə də: eyni Zod sxemi (`@orchestris/shared`)
  // hər iki tərəfdə işləyir, ona görə istifadəçi səhvi göndərməzdən ƏVVƏL görür,
  // server isə heç nəyə etibar etmir.
  const parsed = parseSteps(stepsText)
  const stepsError = 'error' in parsed ? parsed.error : null

  const create = useMutation({
    mutationFn: () => {
      if ('error' in parsed) throw new Error(parsed.error)
      return api.createWorkflow({ contextId, name, steps: parsed.steps })
    },
    onSuccess: () => {
      setName('')
      void qc.invalidateQueries({ queryKey: ['workflows'] })
    },
  })

  const run = useMutation({
    mutationFn: (id: string) => api.runWorkflow(id),
    onSuccess: (r) => {
      setRunId(r.workflowRunId)
      void qc.invalidateQueries({ queryKey: ['workflows'] })
    },
  })

  const archive = useMutation({
    mutationFn: (id: string) => api.updateWorkflow(id, { archived: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['workflows'] }),
  })

  const workflows = data?.workflows ?? []

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-xl font-semibold">Zəncirlər</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Bir taskın nəticəsi digərinin girişi olur. Şərtlər və dəyişən
        əvəzlənməsi <span className="text-ink">sıfır token</span> xərcləyir —
        hər addım isə öz nərdivanından keçir.
      </p>

      <form
        className="mb-8 space-y-4 rounded-lg border border-white/10 bg-surface-2 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (contextId !== '' && name.trim() !== '' && stepsError === null) create.mutate()
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Kontekst
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">— seç —</option>
              {contexts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Ad
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sənəd hazırla və yoxla"
              className="w-72 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Addımlar (JSON)
          <textarea
            value={stepsText}
            onChange={(e) => setStepsText(e.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full rounded border border-white/15 bg-surface px-3 py-2 font-mono text-xs text-ink"
          />
        </label>

        {'error' in parsed ? (
          <p className="text-sm text-bad">{parsed.error}</p>
        ) : (
          <StepList steps={parsed.steps} />
        )}

        <button
          type="submit"
          disabled={
            contextId === '' || name.trim() === '' || stepsError !== null || create.isPending
          }
          className="rounded bg-accent/20 px-4 py-2 text-sm text-accent disabled:opacity-40"
        >
          {create.isPending ? 'Yaradılır…' : 'Zənciri yarat'}
        </button>

        {create.error !== null && <p className="text-sm text-bad">{String(create.error)}</p>}
      </form>

      <h2 className="mb-2 text-sm font-medium text-ink-dim">Mövcud zəncirlər</h2>
      {workflows.length === 0 && (
        <p className="text-sm text-ink-dim">Hələ zəncir yoxdur.</p>
      )}

      <ul className="space-y-3">
        {workflows.map((wf) => (
          <WorkflowCard
            key={wf.id}
            workflow={wf}
            open={openId === wf.id}
            onToggle={() => setOpenId(openId === wf.id ? null : wf.id)}
            onRun={() => run.mutate(wf.id)}
            onArchive={() => archive.mutate(wf.id)}
            running={run.isPending}
          />
        ))}
      </ul>

      {runId !== null && <WorkflowRunPanel runId={runId} onClose={() => setRunId(null)} />}
    </div>
  )
}

function WorkflowCard({
  workflow,
  open,
  onToggle,
  onRun,
  onArchive,
  running,
}: {
  workflow: WorkflowRow
  open: boolean
  onToggle: () => void
  onRun: () => void
  onArchive: () => void
  running: boolean
}): React.JSX.Element {
  const parsed = parseSteps(workflow.stepsJson)
  const last = workflow.lastRun

  return (
    <li className="rounded-lg border border-white/10 bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button onClick={onToggle} className="min-w-0 text-left">
          <span className="text-sm font-medium">{workflow.name}</span>
          <span className="ml-2 text-xs text-ink-dim">
            {'steps' in parsed ? `${parsed.steps.length} addım` : 'tərif oxunmadı'}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-3">
          {last != null && (
            <span
              className={`text-xs ${
                last.status === 'succeeded'
                  ? 'text-good'
                  : last.status === 'running'
                    ? 'text-ink-dim'
                    : 'text-bad'
              }`}
            >
              son icra: {last.status}
            </span>
          )}
          <button
            onClick={onRun}
            disabled={running || 'error' in parsed}
            className="rounded bg-accent/20 px-3 py-1.5 text-xs text-accent disabled:opacity-40"
          >
            İşə sal
          </button>
          <button
            onClick={onArchive}
            className="rounded bg-white/5 px-3 py-1.5 text-xs text-ink-dim"
          >
            Arxivlə
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3">
          {'steps' in parsed && <StepList steps={parsed.steps} />}
          <SchedulePanel workflowId={workflow.id} />
        </div>
      )}
    </li>
  )
}
