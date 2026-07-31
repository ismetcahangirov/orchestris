import { describe, expect, it } from 'vitest'
import { TaskPool } from './pool.js'

/** Əl ilə bitirilə bilən iş — hovuzun sırasını determinist yoxlamaq üçün. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('TaskPool', () => {
  it('limitdən çox task eyni anda işləmir', async () => {
    const pool = new TaskPool()
    const gates = [deferred(), deferred(), deferred()]
    const started: number[] = []

    const runs = gates.map((g, i) =>
      pool.run('ctx', 2, async () => {
        started.push(i)
        await g.promise
      }),
    )

    await Promise.resolve()
    expect(started).toEqual([0, 1])
    expect(pool.activeCount('ctx')).toBe(2)
    expect(pool.waitingCount('ctx')).toBe(1)

    gates[0]?.resolve()
    await runs[0]
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2])

    gates[1]?.resolve()
    gates[2]?.resolve()
    await Promise.all(runs)
    expect(pool.activeCount('ctx')).toBe(0)
  })

  it('növbə FIFO-dur — göndərilmə sırası saxlanılır', async () => {
    const pool = new TaskPool()
    const gate = deferred()
    const order: string[] = []

    const first = pool.run('ctx', 1, async () => {
      order.push('a')
      await gate.promise
    })
    const rest = ['b', 'c', 'd'].map((name) =>
      pool.run('ctx', 1, async () => {
        order.push(name)
      }),
    )

    gate.resolve()
    await Promise.all([first, ...rest])
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('fərqli kontekstlər bir-birini gözlətmir', async () => {
    const pool = new TaskPool()
    const gate = deferred()
    const started: string[] = []

    const blocked = pool.run('ctx-1', 1, async () => {
      started.push('ctx-1')
      await gate.promise
    })
    const other = pool.run('ctx-2', 1, async () => {
      started.push('ctx-2')
    })

    await other
    expect(started).toEqual(['ctx-1', 'ctx-2'])
    gate.resolve()
    await blocked
  })

  it('sınan task slotu BURAXIR — yoxsa növbə əbədi ilişərdi', async () => {
    const pool = new TaskPool()
    const failed = pool.run('ctx', 1, () => Promise.reject(new Error('sındı')))
    await expect(failed).rejects.toThrow('sındı')

    let ran = false
    await pool.run('ctx', 1, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('limit icra gedərkən artırılsa növbədəkilər dərhal faydalanır', async () => {
    const pool = new TaskPool()
    const gates = [deferred(), deferred(), deferred()]
    const started: number[] = []

    const first = pool.run('ctx', 1, async () => {
      started.push(0)
      await gates[0]?.promise
    })
    // Bu ikisi limit 1 ilə gözləyir; sonuncu çağırış limiti 3-ə qaldırır.
    const second = pool.run('ctx', 1, async () => {
      started.push(1)
      await gates[1]?.promise
    })
    const third = pool.run('ctx', 3, async () => {
      started.push(2)
      await gates[2]?.promise
    })

    gates[0]?.resolve()
    await first
    await Promise.resolve()
    // Bir slot boşaldı, limit isə 3-dür → hər iki gözləyən oyanır.
    expect(started).toEqual([0, 1, 2])

    gates[1]?.resolve()
    gates[2]?.resolve()
    await Promise.all([second, third])
  })
})

describe('yield — gözləyərkən slot buraxılır (Faza 5B)', () => {
  it('cavab gözləyən task limiti TUTMUR', async () => {
    // MEXANİZMİN BÜTÜN MƏNASI: `max_parallel = 1` olan kontekstdə cavab
    // gözləyən task slotu saxlasaydı, iş sahəsi TAM kilidlənərdi.
    const pool = new TaskPool()
    let secondRan = false
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = pool.run('ctx', 1, async () => {
      await pool.yield('ctx', 1, () => gate)
      return 'birinci'
    })
    const second = pool.run('ctx', 1, async () => {
      secondRan = true
      return 'ikinci'
    })

    expect(await second).toBe('ikinci')
    expect(secondRan).toBe(true)
    release()
    expect(await first).toBe('birinci')
  })

  it('yield-dən sonra slot YENİDƏN alınır — limit aşılmır', async () => {
    const pool = new TaskPool()
    let peak = 0
    let active = 0
    const track = async (): Promise<void> => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
    }

    await Promise.all([
      pool.run('ctx', 1, async () => {
        await pool.yield('ctx', 1, async () => undefined)
        await track()
      }),
      pool.run('ctx', 1, track),
    ])
    expect(peak).toBe(1)
  })

  it('yield içindəki xəta slotu geri qaytarır', async () => {
    const pool = new TaskPool()
    await expect(
      pool.run('ctx', 1, () =>
        pool.yield('ctx', 1, () => Promise.reject(new Error('sındı'))),
      ),
    ).rejects.toThrow('sındı')
    expect(pool.activeCount('ctx')).toBe(0)
  })

  it('yield-dən sonra sayğac sıfıra qayıdır', async () => {
    const pool = new TaskPool()
    await pool.run('ctx', 2, () => pool.yield('ctx', 2, async () => undefined))
    expect(pool.activeCount('ctx')).toBe(0)
    expect(pool.waitingCount('ctx')).toBe(0)
  })
})
