import { describe, expect, it } from 'vitest'
import { catalogRefreshVerdict, refreshErrorReason } from './catalogRefresh.js'

const BUNDLED = { source: 'bundled' as const, providerCount: 3 }
const CACHED = (fetchedAt: number) => ({
  source: 'cache' as const,
  fetchedAt,
  providerCount: 175,
})

describe('catalogRefreshVerdict', () => {
  it('server "oldu" deyibsə yeniləndi sayılır', () => {
    expect(
      catalogRefreshVerdict({
        requestError: null,
        before: BUNDLED,
        after: CACHED(1000),
      }),
    ).toEqual({ kind: 'refreshed', fetchedAt: 1000 })
  })

  it('sorğu sınsa DA kataloq irəliləyibsə YENİLƏNDİ sayılır', () => {
    // Bu, issue #46-nın mahiyyətidir: klientin `fetch`-i həqiqət mənbəyi
    // DEYİL. Server işi sona çatdırıbsa istifadəçiyə "sındı" deyilməməlidir.
    expect(
      catalogRefreshVerdict({
        requestError: 'fetch failed',
        before: CACHED(1000),
        after: CACHED(2000),
      }),
    ).toEqual({ kind: 'refreshed', fetchedAt: 2000 })
  })

  it('sorğu sınsa da snapshot → keş keçidi yenilənmə sayılır', () => {
    // `fetchedAt` müqayisəsi kifayət etmir: `bundled` mənbəyində o sahə
    // ÜMUMİYYƏTLƏ yoxdur, yəni ilk uğurlu yeniləmə yalnız mənbə dəyişikliyi
    // kimi görünür.
    expect(
      catalogRefreshVerdict({
        requestError: 'fetch failed',
        before: BUNDLED,
        after: CACHED(2000),
      }),
    ).toEqual({ kind: 'refreshed', fetchedAt: 2000 })
  })

  it('sorğu sındı və kataloq DƏYİŞMƏDİ — səbəbi ilə uğursuz', () => {
    expect(
      catalogRefreshVerdict({
        requestError: '502 /api/registry/refresh: models.dev → HTTP 503',
        before: CACHED(1000),
        after: CACHED(1000),
      }),
    ).toEqual({
      kind: 'failed',
      reason: '502 /api/registry/refresh: models.dev → HTTP 503',
    })
  })

  it('kataloqun yeni vəziyyəti oxunmadıqda uğursuz sayılır', () => {
    // `after` yoxdur = `/api/providers` sorğusu da sınıb. Bilmədiyimizi
    // "yeniləndi" kimi göstərmək məhz issue #46-daki yalanın əksi olardı.
    expect(
      catalogRefreshVerdict({
        requestError: 'fetch failed',
        before: CACHED(1000),
        after: undefined,
      }),
    ).toEqual({ kind: 'failed', reason: 'fetch failed' })
  })

  it('server "oldu" deyibsə kataloq oxunmasa belə yeniləndi sayılır', () => {
    expect(
      catalogRefreshVerdict({
        requestError: null,
        before: BUNDLED,
        after: undefined,
      }),
    ).toEqual({ kind: 'refreshed' })
  })

  it('kataloq geriyə gedibsə yenilənmə sayılmır', () => {
    // Praktikada olmamalıdır, amma "daha köhnə nüsxə" heç bir halda
    // yenilənmə deyil.
    expect(
      catalogRefreshVerdict({
        requestError: 'fetch failed',
        before: CACHED(2000),
        after: BUNDLED,
      }),
    ).toEqual({ kind: 'failed', reason: 'fetch failed' })
  })
})

describe('refreshErrorReason', () => {
  it('serverin JSON gövdəsindən yalnız səbəbi çıxarır', () => {
    // `request` xəta mətnini `"502 <url>: <gövdə>"` kimi qurur. Gövdə JSON-dur
    // və istifadəçiyə xam JSON göstərmək səbəbi oxunmaz edir.
    const err = new Error(
      '502 /api/registry/refresh: {"ok":false,"error":"models.dev → HTTP 503"}',
    )
    expect(refreshErrorReason(err)).toBe('models.dev → HTTP 503')
  })

  it('Fastify gövdəsindən OXUNAQLI sahəni (`message`) seçir', () => {
    // Ölçülmüş (issue #50): Fastify-ın öz xəta gövdəsində `error` KATEQORİYADIR
    // ("Bad Request"), səbəb isə `message`-dədir. `error`-u götürsək UI
    // "Səbəb: Bad Request" yazır — yəni səbəb yerinə heç nə.
    const err = new Error(
      '400 /api/registry/refresh: {"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY",' +
        '"error":"Bad Request","message":"Body cannot be empty when content-type is set to \'application/json\'"}',
    )
    expect(refreshErrorReason(err)).toBe(
      "Body cannot be empty when content-type is set to 'application/json'",
    )
  })

  it('JSON olmayan gövdəni olduğu kimi saxlayır', () => {
    const err = new Error('Failed to fetch')
    expect(refreshErrorReason(err)).toBe('Failed to fetch')
  })

  it('Error olmayan dəyəri də mətnə çevirir', () => {
    expect(refreshErrorReason('kəsildi')).toBe('kəsildi')
  })
})
