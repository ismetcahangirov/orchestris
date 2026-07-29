import { describe, expect, it } from 'vitest'
import { openDb, type Db } from './client.js'
import { createContext, createRun, createTask, setTaskType } from './repo.js'
import {
  countBossAssistedTasks,
  getTemplate,
  listTemplates,
  recordTemplateEscalation,
  recordTemplateUse,
  saveTemplate,
} from './template-repo.js'

const ASSIST_RUNGS = [4, 5, 7]

function template(over: Partial<Parameters<typeof saveTemplate>[1]> = {}) {
  return {
    id: 'hash-1',
    taskType: 'code',
    workerPrompt: 'ADDIMLAR',
    rubric: 'ŞƏRTLƏR',
    authoredByModelId: 'başçı',
    ...over,
  }
}

function setup(): { db: Db; contextId: string } {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  return { db, contextId: ctx.id }
}

/** Bir task + onun icraları. `escalatedFrom` verilməsə eskalasiya sayılmır. */
function taskWithRuns(
  db: Db,
  contextId: string,
  taskType: string,
  runs: { rung: number; escalated: boolean }[],
): string {
  const task = createTask(db, { contextId, prompt: 'p' })
  setTaskType(db, task.id, taskType)
  let previous: string | undefined
  for (const r of runs) {
    const run = createRun(db, {
      taskId: task.id,
      runnerId: 'fake',
      modelId: 'm',
      ladderRung: r.rung,
      ...(r.escalated && previous !== undefined ? { escalatedFromRunId: previous } : {}),
    })
    previous = run.id
  }
  return task.id
}

describe('task_templates — saxlama', () => {
  it('şablon yazılır və tipə görə oxunur', () => {
    const { db } = setup()

    saveTemplate(db, template())

    expect(getTemplate(db, 'code')).toMatchObject({
      taskType: 'code',
      workerPrompt: 'ADDIMLAR',
      uses: 0,
    })
  })

  it('tip başına BİR şablon — yenidən yazılış əvəz edir', () => {
    const { db } = setup()
    saveTemplate(db, template())

    saveTemplate(db, template({ id: 'hash-2', workerPrompt: 'YENİ' }))

    expect(listTemplates(db)).toHaveLength(1)
    expect(getTemplate(db, 'code')?.workerPrompt).toBe('YENİ')
  })

  it('yenidən yazılışda sayğaclar SIFIRLANIR — iki mətnin ölçüsü qarışmamalıdır', () => {
    const { db } = setup()
    saveTemplate(db, template())
    recordTemplateUse(db, 'code')
    recordTemplateEscalation(db, 'code')

    saveTemplate(db, template({ id: 'hash-2', workerPrompt: 'YENİ' }))

    expect(getTemplate(db, 'code')).toMatchObject({ uses: 0, escalationsAfter: 0 })
  })

  it('xərc verilməyəndə NULL qalır — `0` "pulsuz" yalanı olardı', () => {
    const { db } = setup()

    saveTemplate(db, template())

    expect(getTemplate(db, 'code')?.authoringCostUsd).toBeNull()
  })

  it('istifadə və eskalasiya AYRI sayılır — "şablon işləyirmi?" cavabı budur', () => {
    const { db } = setup()
    saveTemplate(db, template())

    recordTemplateUse(db, 'code')
    recordTemplateUse(db, 'code')
    recordTemplateEscalation(db, 'code')

    expect(getTemplate(db, 'code')).toMatchObject({ uses: 2, escalationsAfter: 1 })
  })
})

describe('countBossAssistedTasks — distillə qapısı', () => {
  it('eskalasiya ilə gələn başçı icrası sayılır', () => {
    const { db, contextId } = setup()
    taskWithRuns(db, contextId, 'code', [
      { rung: 2, escalated: false },
      { rung: 7, escalated: true },
    ])

    expect(countBossAssistedTasks(db, 'code', ASSIST_RUNGS)).toBe(1)
  })

  it('ESKALASİYASIZ başçı icrası sayılmır — `boss-only` qapını açmamalıdır', () => {
    // Qayda 25: o profil baseline ölçməsidir, orada hər task onsuz da başçıya
    // gedir. Sayılsaydı, distillə ölçmə profilindən doğardı.
    const { db, contextId } = setup()
    taskWithRuns(db, contextId, 'code', [{ rung: 7, escalated: false }])

    expect(countBossAssistedTasks(db, 'code', ASSIST_RUNGS)).toBe(0)
  })

  it('işçinin təkrar cəhdləri (Pillə 2) sayılmır', () => {
    const { db, contextId } = setup()
    taskWithRuns(db, contextId, 'code', [
      { rung: 2, escalated: false },
      { rung: 2, escalated: true },
    ])

    expect(countBossAssistedTasks(db, 'code', ASSIST_RUNGS)).toBe(0)
  })

  it('bir taskdakı İKİ kömək icrası bir dəfə sayılır', () => {
    // Pillə 4/5 bir taskda iki sətir yazır (başçının qısa mətni + işçinin
    // köməkli cəhdi) — icra saysaydıq bir task qapını təkbaşına açardı.
    const { db, contextId } = setup()
    taskWithRuns(db, contextId, 'code', [
      { rung: 2, escalated: false },
      { rung: 4, escalated: true },
      { rung: 4, escalated: true },
    ])

    expect(countBossAssistedTasks(db, 'code', ASSIST_RUNGS)).toBe(1)
  })

  it('başqa tipin taskları sayılmır', () => {
    const { db, contextId } = setup()
    taskWithRuns(db, contextId, 'translate', [
      { rung: 2, escalated: false },
      { rung: 7, escalated: true },
    ])

    expect(countBossAssistedTasks(db, 'code', ASSIST_RUNGS)).toBe(0)
  })
})
