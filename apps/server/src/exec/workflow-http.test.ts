import { describe, expect, it, vi } from 'vitest'
import { checkUrl, executeHttpStep, readHttpAllowList } from './workflow-http.js'

const ALLOW = { hosts: ['api.example.com'] }

describe('readHttpAllowList', () => {
  it('vergüllə ayrılmış siyahını oxuyur və normallaşdırır', () => {
    const list = readHttpAllowList({ ORCHESTRIS_WORKFLOW_HTTP_ALLOW: ' A.com , b.COM ,, ' })
    expect(list.hosts).toEqual(['a.com', 'b.com'])
  })

  it('dəyişən yoxdursa siyahı BOŞDUR — yəni heç nəyə icazə yoxdur', () => {
    expect(readHttpAllowList({}).hosts).toEqual([])
  })
})

describe('checkUrl — fail-closed', () => {
  it('siyahı boşdursa HƏR host rədd olunur', () => {
    // Fail-open yazsaydıq, dəyişəni təyin etməyi unudan istifadəçi ən geniş
    // icazəni səssizcə alardı — və bunu yalnız məlumat kənara çıxandan sonra
    // bilərdi.
    const verdict = checkUrl('https://api.example.com/x', { hosts: [] })
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toContain('ORCHESTRIS_WORKFLOW_HTTP_ALLOW')
  })

  it('ağ siyahıdakı hosta icazə verir', () => {
    expect(checkUrl('https://api.example.com/hook', ALLOW).ok).toBe(true)
  })

  it('host müqayisəsi TAM uyğunluqdur — prefiks/suffiks deyil', () => {
    // `endsWith` işlətsəydik `evil-example.com` keçərdi; prefiks müqayisəsi isə
    // `api.example.com.attacker.net`-i buraxardı.
    expect(checkUrl('https://evil-api.example.com/x', ALLOW).ok).toBe(false)
    expect(checkUrl('https://api.example.com.attacker.net/x', ALLOW).ok).toBe(false)
    expect(checkUrl('https://sub.api.example.com/x', ALLOW).ok).toBe(false)
  })

  it('`file:` və digər sxemlər rədd olunur', () => {
    expect(checkUrl('file:///C:/gizli.txt', { hosts: [''] }).ok).toBe(false)
    expect(checkUrl('ftp://api.example.com/x', ALLOW).ok).toBe(false)
  })

  it('URL-də istifadəçi adı/parol rədd olunur', () => {
    // Belə URL sirri zəncir tərifinə — yəni SQLite-a və oradan UI-a — yazardı.
    const verdict = checkUrl('https://user:parol@api.example.com/x', ALLOW)
    expect(verdict.ok).toBe(false)
    expect(verdict.error).toContain('parol')
  })

  it('oxunmayan URL rədd olunur', () => {
    expect(checkUrl('bu url deyil', ALLOW).ok).toBe(false)
  })
})

describe('executeHttpStep', () => {
  it('icazəsiz URL-də ŞƏBƏKƏYƏ ÇIXMIR', async () => {
    const fetchImpl = vi.fn()
    const res = await executeHttpStep(
      { method: 'GET', url: 'https://başqa.com/x' },
      { allow: ALLOW, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(res.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cavab mətnini qaytarır', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('cavab', { status: 200 }))
    const res = await executeHttpStep(
      { method: 'POST', url: 'https://api.example.com/hook', body: '{"a":1}' },
      { allow: ALLOW, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(res).toMatchObject({ ok: true, status: 200, output: 'cavab' })
  })

  it('API açarına oxşayan mətn cavabdan KƏSİLİR', async () => {
    // Qayda 18: endpoint göndərilən məzmunu (və bəzən konfiqurasiyanı) cavabda
    // əks etdirə bilir, o mətn isə DB-yə və oradan UI-a gedir.
    const leak = 'xəta: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(leak, { status: 400 }))
    const res = await executeHttpStep(
      { method: 'GET', url: 'https://api.example.com/x' },
      { allow: ALLOW, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(res.output).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('sınmış sorğu XƏTA ATMIR — zəncir ona şərtlə reaksiya verə bilməlidir', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('şəbəkə yoxdur')
    })
    const res = await executeHttpStep(
      { method: 'GET', url: 'https://api.example.com/x' },
      { allow: ALLOW, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(res.ok).toBe(false)
    expect(res.output).toContain('şəbəkə yoxdur')
  })

  it('4xx cavab `ok: false`-dur, amma mətni saxlanılır', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('tapılmadı', { status: 404 }))
    const res = await executeHttpStep(
      { method: 'GET', url: 'https://api.example.com/x' },
      { allow: ALLOW, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(res).toMatchObject({ ok: false, status: 404, output: 'tapılmadı' })
  })

  it('GET sorğusunda gövdə GÖNDƏRİLMİR', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'))
    await executeHttpStep(
      { method: 'GET', url: 'https://api.example.com/x', body: 'atılmalıdır' },
      { allow: ALLOW, fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty('body')
  })
})
