import { describe, expect, it, vi } from 'vitest'
import { BudgetGuard } from './budget.js'

const usage = (o: {
  out?: number
  cost?: number
  billed?: 'real' | 'subscription'
}) =>
  ({
    t: 'usage' as const,
    inputTokens: 0,
    outputTokens: o.out ?? 0,
    ...(o.cost !== undefined ? { costUsd: o.cost } : {}),
    billed: o.billed ?? 'real',
  })

describe('BudgetGuard — token limiti', () => {
  it('limit altında icazə verir', () => {
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    expect(g.check(usage({ out: 50 }))).toBeNull()
  })

  it('limit aşıldıqda budget_exceeded qaytarır', () => {
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    const v = g.check(usage({ out: 101 }))
    expect(v?.class).toBe('budget_exceeded')
    expect(v?.message).toContain('101')
    expect(v?.message).toContain('100')
  })

  it('limit dəqiq bərabərdirsə icazə verir', () => {
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    expect(g.check(usage({ out: 100 }))).toBeNull()
  })

  it('abunəlik icralarında da token limiti tətbiq edilir', () => {
    const g = new BudgetGuard({ maxOutputTokens: 10, subscriptionBilled: true })
    expect(g.check(usage({ out: 11, billed: 'subscription' }))?.class).toBe(
      'budget_exceeded',
    )
  })
})

describe('BudgetGuard — xərc limiti', () => {
  it('xərc limiti aşıldıqda budget_exceeded qaytarır', () => {
    const g = new BudgetGuard({ maxCostUsd: 0.01 })
    expect(g.check(usage({ cost: 0.011 }))?.class).toBe('budget_exceeded')
  })

  it('abunəlikdən ödənilən icralarda xərc limiti tətbiq edilmir', () => {
    // Ölçülmüş səbəb: `claude` CLI-nın ~21.7k token döşəməsi trivial taskda
    // ~$0.0085 istinad qiyməti verir, amma real pul çıxmır. Bunu real limit
    // saysaq hər icra kəsilərdi.
    const g = new BudgetGuard({ maxCostUsd: 0.001, subscriptionBilled: true })
    expect(g.check(usage({ cost: 0.5, billed: 'subscription' }))).toBeNull()
  })

  it('hadisənin billed sahəsi subscription olsa da xərc limiti tətbiq edilmir', () => {
    // Konfiqurasiya `subscriptionBilled` deməsə də, hadisənin özü abunəlik
    // deyirsə ona etibar edilir — runner öz billing rejimini daha yaxşı bilir.
    const g = new BudgetGuard({ maxCostUsd: 0.001 })
    expect(g.check(usage({ cost: 0.5, billed: 'subscription' }))).toBeNull()
  })

  it('costUsd YOXDURSA xərc limiti yoxlanmır — "bilinmir" 0 demək deyil', () => {
    // Codex xərc bildirmir. Yoxluğu `0` kimi oxusaq limit heç vaxt işə düşməz;
    // sonsuz kimi oxusaq hər codex icrası kəsilər. Doğrusu: yoxlamamaq və
    // token/vaxt limitlərinə güvənmək.
    const g = new BudgetGuard({ maxCostUsd: 0.001 })
    expect(g.check(usage({}))).toBeNull()
  })
})

describe('BudgetGuard — vaxt limiti', () => {
  it('vaxt limiti aşıldıqda budget_exceeded qaytarır', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-26T00:00:00Z'))
      const g = new BudgetGuard({ maxSeconds: 30 })
      expect(g.checkClock()).toBeNull()
      vi.advanceTimersByTime(31_000)
      const v = g.checkClock()
      expect(v?.class).toBe('budget_exceeded')
      expect(v?.message).toContain('30')
    } finally {
      vi.useRealTimers()
    }
  })

  it('abunəlik icralarında da vaxt limiti tətbiq edilir', () => {
    vi.useFakeTimers()
    try {
      const g = new BudgetGuard({ maxSeconds: 5, subscriptionBilled: true })
      vi.advanceTimersByTime(6_000)
      expect(g.checkClock()?.class).toBe('budget_exceeded')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('BudgetGuard — limitsiz hal', () => {
  it('heç bir limit verilməyəndə həmişə icazə verir', () => {
    const g = new BudgetGuard({})
    expect(g.check(usage({ out: 1e9, cost: 1e6 }))).toBeNull()
    expect(g.checkClock()).toBeNull()
  })

  it('usage olmayan hadisələri sakitcə buraxır', () => {
    const g = new BudgetGuard({ maxOutputTokens: 1 })
    expect(g.check({ t: 'text', delta: 'çox uzun mətn' })).toBeNull()
    expect(g.check({ t: 'done', stopReason: 'end_turn' })).toBeNull()
  })
})

describe('BudgetGuard — kumulyativ toplama YOXDUR', () => {
  it('eyni kumulyativ dəyər iki dəfə gəlsə limiti aşdırmır', () => {
    // `usage` mütləq anlıq görüntüdür, delta deyil. Toplamaq ikiqat sayma
    // verər və limiti süni şəkildə aşdırardı.
    const g = new BudgetGuard({ maxOutputTokens: 100 })
    expect(g.check(usage({ out: 60 }))).toBeNull()
    expect(g.check(usage({ out: 60 }))).toBeNull()
  })
})

describe('BudgetGuard — pozuntu formatı', () => {
  it('pozuntu retryable: false olur — sərt kəsimdir', () => {
    const g = new BudgetGuard({ maxOutputTokens: 1 })
    expect(g.check(usage({ out: 2 }))?.retryable).toBe(false)
  })
})
