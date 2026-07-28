import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from './client.js'
import { createContext, createTask } from './repo.js'
import {
  listRoutingDecisions,
  latestRoutingDecision,
  recordRoutingDecision,
} from './routing-repo.js'

function seed(): { db: Db; taskId: string } {
  const db = openDb(':memory:')
  const ctx = createContext(db, { name: 'C' })
  const task = createTask(db, { contextId: ctx.id, prompt: 'salam' })
  return { db, taskId: task.id }
}

const RULE_DECISION = {
  strategy: 'rule' as const,
  runnerId: 'cli:claude',
  modelId: 'claude-haiku-4-5',
  chosenRowId: 'cli:claude:claude-haiku-4-5',
  confidence: 0.9,
  reason: 'qayda "file-work-to-cli"',
  ruleId: 'file-work-to-cli',
  decisionTokens: 0,
  decisionCostUsd: 0,
}

describe('recordRoutingDecision', () => {
  it('qərarı bütün sahələri ilə yazır', () => {
    const { db, taskId } = seed()
    recordRoutingDecision(db, taskId, RULE_DECISION)

    expect(latestRoutingDecision(db, taskId)).toMatchObject({
      strategy: 'rule',
      runnerId: 'cli:claude',
      chosenModelId: 'cli:claude:claude-haiku-4-5',
      ruleId: 'file-work-to-cli',
      decisionTokens: 0,
      decisionCostUsd: 0,
    })
  })

  it('xərc bilinmirsə NULL yazır — 0 YOX', () => {
    // `0` "qərar pulsuz idi" deməkdir. Klassifikator abunəlik CLI-ı ilə
    // işləyəndə xərc bilinmir; onu 0 yazsaq orkestrasiya xərci olduğundan
    // az görünərdi (issue #8).
    const { db, taskId } = seed()
    recordRoutingDecision(db, taskId, {
      ...RULE_DECISION,
      strategy: 'classifier',
      decisionTokens: 52,
      decisionCostUsd: undefined,
    })
    const row = latestRoutingDecision(db, taskId)
    expect(row?.decisionCostUsd).toBeNull()
    expect(row?.decisionTokens).toBe(52)
  })

  it('bir task üçün bir neçə qərar saxlanılır — sonuncusu qaytarılır', () => {
    const { db, taskId } = seed()
    recordRoutingDecision(db, taskId, RULE_DECISION)
    recordRoutingDecision(db, taskId, {
      ...RULE_DECISION,
      strategy: 'fallback',
      reason: 'ikinci cəhd',
    })

    expect(listRoutingDecisions(db, taskId)).toHaveLength(2)
    expect(latestRoutingDecision(db, taskId)?.strategy).toBe('fallback')
  })

  it('qeydiyyatda olmayan model üçün chosenModelId NULL ola bilər', () => {
    // Əl ilə seçimdə istifadəçi cədvəldə olmayan model adı yaza bilər.
    const { db, taskId } = seed()
    recordRoutingDecision(db, taskId, {
      ...RULE_DECISION,
      strategy: 'manual',
      chosenRowId: null,
      ruleId: undefined,
    })
    expect(latestRoutingDecision(db, taskId)?.chosenModelId).toBeNull()
  })

  it('task silindikdə qərarlar da silinir', () => {
    const { db, taskId } = seed()
    recordRoutingDecision(db, taskId, RULE_DECISION)
    db.run(sql`DELETE FROM tasks WHERE id = ${taskId}`)
    expect(listRoutingDecisions(db, taskId)).toHaveLength(0)
  })
})
