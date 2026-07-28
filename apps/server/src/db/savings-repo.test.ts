import { describe, expect, it } from 'vitest'
import type { TaskSavings } from '../exec/savings.js'
import { openDb, type Db } from './client.js'
import { createContext, createTask } from './repo.js'
import { getSavings, recordSavings, summarizeSavings } from './savings-repo.js'

function savings(over: Partial<TaskSavings> = {}): TaskSavings {
  return {
    taskId: 'əvəz olunur',
    actualCostUsd: 0.01,
    actualSubscriptionUsd: 0,
    baselineCostUsd: 0.5,
    baselineModelId: 'anthropic:başçı',
    baselineSubscription: false,
    orchestrationCostUsd: 0,
    memoryCostUsd: 0,
    netSavingUsd: 0.49,
    cachedHit: false,
    baselineTokens: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    byRung: [],
    ...over,
  }
}

function setup(): { db: Db; newTask: (type?: string) => string } {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  return {
    db,
    newTask: (type = 'code') =>
      createTask(db, { contextId: ctx.id, prompt: 'p', taskType: type }).id,
  }
}

describe('recordSavings', () => {
  it('qeydi bütün sahələri ilə yazır', () => {
    const { db, newTask } = setup()
    const taskId = newTask()
    recordSavings(db, savings({ taskId }))

    expect(getSavings(db, taskId)).toMatchObject({
      taskId,
      taskType: 'code',
      actualCostUsd: 0.01,
      baselineCostUsd: 0.5,
      netSavingUsd: 0.49,
      baselineModelId: 'anthropic:başçı',
    })
  })

  it('naməlum xərci NULL kimi yazır — 0 YOX', () => {
    const { db, newTask } = setup()
    const taskId = newTask()
    recordSavings(db, savings({ taskId, actualCostUsd: null, netSavingUsd: null }))

    const row = getSavings(db, taskId)
    expect(row?.actualCostUsd).toBeNull()
    expect(row?.netSavingUsd).toBeNull()
  })

  it('eyni task üçün təkrar yazılış sətri ƏVƏZ EDİR, ikinci sətir yaratmır', () => {
    // Yoxlama dövrəsi taskı bir neçə dəfə icra edə bilər; ledger task başına
    // BİR sətirdir, yoxsa qənaət ikiqat sayılardı.
    const { db, newTask } = setup()
    const taskId = newTask()
    recordSavings(db, savings({ taskId, netSavingUsd: 0.1 }))
    recordSavings(db, savings({ taskId, netSavingUsd: 0.9 }))

    expect(getSavings(db, taskId)?.netSavingUsd).toBe(0.9)
    expect(summarizeSavings(db).taskCount).toBe(1)
  })
})

describe('summarizeSavings', () => {
  it('boş bazada sıfır qaytarır, çökmür', () => {
    const { db } = setup()
    expect(summarizeSavings(db)).toMatchObject({
      taskCount: 0,
      netSavingUsd: 0,
      actualCostUsd: 0,
    })
  })

  it('real pulu və abunəliyi AYRI toplayır', () => {
    const { db, newTask } = setup()
    recordSavings(db, savings({ taskId: newTask(), actualCostUsd: 0.02, actualSubscriptionUsd: 0 }))
    recordSavings(
      db,
      savings({ taskId: newTask(), actualCostUsd: 0, actualSubscriptionUsd: 0.0085 }),
    )

    const s = summarizeSavings(db)
    expect(s.actualCostUsd).toBeCloseTo(0.02, 6)
    expect(s.actualSubscriptionUsd).toBeCloseTo(0.0085, 6)
  })

  it('orkestrasiya xərcini AYRICA sətir kimi verir', () => {
    // Qəbul kriteriyası: orkestrasiya xərci daxil edilir və ayrıca görünür.
    const { db, newTask } = setup()
    recordSavings(db, savings({ taskId: newTask(), orchestrationCostUsd: 0.003 }))
    expect(summarizeSavings(db).orchestrationCostUsd).toBeCloseTo(0.003, 6)
  })

  it('xərci bilinməyən taskları AYRICA sayır, cəmi pozmur', () => {
    const { db, newTask } = setup()
    recordSavings(db, savings({ taskId: newTask(), netSavingUsd: 1 }))
    recordSavings(db, savings({ taskId: newTask(), actualCostUsd: null, netSavingUsd: null }))

    const s = summarizeSavings(db)
    expect(s.netSavingUsd).toBeCloseTo(1, 6)
    expect(s.unknownCostTasks).toBe(1)
    expect(s.taskCount).toBe(2)
  })

  it('keş vurmalarını ayrıca göstərir', () => {
    const { db, newTask } = setup()
    recordSavings(db, savings({ taskId: newTask(), cachedHit: true, netSavingUsd: 0.5 }))
    recordSavings(db, savings({ taskId: newTask(), cachedHit: false, netSavingUsd: 0.2 }))

    const s = summarizeSavings(db)
    expect(s.cacheHits).toBe(1)
    expect(s.cacheSavingUsd).toBeCloseTo(0.5, 6)
  })

  it('task tipinə görə bölgü verir', () => {
    // Mətn tasklarında qənaət kod tasklarından az olacaq — UI bunu DÜRÜST
    // göstərməlidir, gizlətməməlidir (issue #8).
    const { db, newTask } = setup()
    recordSavings(db, savings({ taskId: newTask('code'), netSavingUsd: 1 }))
    recordSavings(db, savings({ taskId: newTask('code'), netSavingUsd: 2 }))
    recordSavings(db, savings({ taskId: newTask('translate'), netSavingUsd: 0.01 }))

    const byType = summarizeSavings(db).byTaskType
    expect(byType).toEqual([
      { taskType: 'code', tasks: 2, netSavingUsd: 3, actualCostUsd: 0.02 },
      { taskType: 'translate', tasks: 1, netSavingUsd: 0.01, actualCostUsd: 0.01 },
    ])
  })

  it('dövr filtrini tətbiq edir', () => {
    const { db, newTask } = setup()
    recordSavings(db, savings({ taskId: newTask() }), { at: 1000 })
    recordSavings(db, savings({ taskId: newTask() }), { at: 5000 })

    expect(summarizeSavings(db, { since: 3000 }).taskCount).toBe(1)
  })

  it('abunəlik baseline-ı olan taskları işarələyir', () => {
    // Abunəlik baseline-ı ilə hesablanan qənaət REAL PUL qənaəti deyil.
    const { db, newTask } = setup()
    recordSavings(db, savings({ taskId: newTask(), baselineSubscription: true }))
    expect(summarizeSavings(db).subscriptionBaselineTasks).toBe(1)
  })
})
