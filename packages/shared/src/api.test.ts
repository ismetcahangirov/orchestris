import { describe, expect, it } from 'vitest'
import {
  CreateTaskBody,
  UpdateContextBody,
  WsClientMessage,
  WsServerMessage,
} from './api.js'

const BASE = { contextId: 'c1', prompt: 'salam', model: 'claude-haiku-4-5' }

describe('CreateTaskBody — runner sahəsi', () => {
  it('CLI runner id-lərini qəbul edir', () => {
    expect(CreateTaskBody.safeParse({ ...BASE, runner: 'cli:claude' }).success).toBe(true)
  })

  it('API runner id-lərini də qəbul edir', () => {
    // Runner siyahısı DİNAMİKDİR: hansı API provayderlərinin runner-i olduğunu
    // yalnız server bilir. Sxemə sabit enum yazsaq, hər yeni provayder üçün
    // paylaşılan paketi dəyişmək lazım gələrdi və köhnə klient/server cütü
    // 400 verərdi. Mövcudluq yoxlaması `POST /api/tasks`-dadır — o, tanınmayan
    // runner üçün mövcudların siyahısı ilə 400 qaytarır.
    expect(CreateTaskBody.safeParse({ ...BASE, runner: 'api:anthropic' }).success).toBe(true)
  })

  it('runner buraxıla bilər', () => {
    expect(CreateTaskBody.safeParse(BASE).success).toBe(true)
  })

  it('boş runner-i rədd edir', () => {
    expect(CreateTaskBody.safeParse({ ...BASE, runner: '' }).success).toBe(false)
  })
})

describe('UpdateContextBody — fayl icazəsi', () => {
  it('cwd null qəbul edir — "iş qovluğunu sil"', () => {
    expect(UpdateContextBody.parse({ cwd: null }).cwd).toBeNull()
  })

  it('tanınmayan səviyyə rədd edilir', () => {
    expect(UpdateContextBody.safeParse({ fileAccess: 'zibil' }).success).toBe(false)
  })

  it('üç səviyyənin hamısı qəbul edilir', () => {
    for (const level of ['read-only', 'workspace', 'extended']) {
      expect(UpdateContextBody.safeParse({ fileAccess: level }).success).toBe(true)
    }
  })

  it('extraDirs massivi qəbul edir', () => {
    expect(UpdateContextBody.parse({ extraDirs: ['/a'] }).extraDirs).toEqual(['/a'])
  })
})

describe('WsServerMessage — activity', () => {
  const RUN = {
    runId: 'r1',
    taskId: 't1',
    contextId: 'c1',
    contextName: 'repo',
    promptExcerpt: 'salam',
    modelId: 'm',
    runnerId: 'cli:claude',
    ladderRung: 2,
    attempt: 1,
    startedAt: 1,
  }

  it('started run daşıyır', () => {
    const msg = WsServerMessage.parse({
      type: 'activity',
      kind: 'started',
      runId: 'r1',
      run: RUN,
    })
    expect(msg.type).toBe('activity')
  })

  it('mənfi pillə qəbul edilir — distillə/bölgü nərdivandan kənardır', () => {
    expect(
      WsServerMessage.safeParse({
        type: 'activity',
        kind: 'started',
        runId: 'r1',
        run: { ...RUN, ladderRung: -1 },
      }).success,
    ).toBe(true)
  })

  it('ended yalnız runId ilə keçir', () => {
    expect(
      WsServerMessage.safeParse({ type: 'activity', kind: 'ended', runId: 'r1' }).success,
    ).toBe(true)
  })

  it('updated NÖVÜ YOXDUR — pillə bir icra daxilində dəyişmir', () => {
    expect(
      WsServerMessage.safeParse({ type: 'activity', kind: 'updated', runId: 'r1' })
        .success,
    ).toBe(false)
  })
})

describe('WsClientMessage — activity abunəliyi', () => {
  it('subscribe_activity qəbul edilir', () => {
    expect(WsClientMessage.safeParse({ type: 'subscribe_activity' }).success).toBe(true)
  })

  it('unsubscribe_activity qəbul edilir', () => {
    expect(WsClientMessage.safeParse({ type: 'unsubscribe_activity' }).success).toBe(true)
  })
})
