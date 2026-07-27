import { describe, expect, it } from 'vitest'
import { classifyErrorText, ERROR_CLASSES, isRetryable } from './errors.js'
import type { ErrorClass } from './errors.js'

describe('classifyErrorText', () => {
  it('401 mesajını auth kimi tanıyır', () => {
    expect(
      classifyErrorText('unexpected status 401 Unauthorized: Missing bearer'),
    ).toBe('auth')
  })

  it('"Not logged in" mesajını auth kimi tanıyır', () => {
    expect(classifyErrorText('Not logged in')).toBe('auth')
  })

  it('"Invalid API key" mesajını auth kimi tanıyır', () => {
    expect(classifyErrorText('Invalid API key')).toBe('auth')
  })

  it('429 mesajını rate_limit kimi tanıyır', () => {
    expect(classifyErrorText('HTTP 429 Too Many Requests')).toBe('rate_limit')
  })

  it('overloaded mesajını overloaded kimi tanıyır', () => {
    expect(classifyErrorText('Error: model is overloaded_error')).toBe(
      'overloaded',
    )
  })

  it('tanınmayan mesajı crashed kimi qaytarır', () => {
    expect(classifyErrorText('something weird happened')).toBe('crashed')
  })

  // Aşağıdaki üç test B1 blocker-ini qoruyur: status kodları hex ID-lərin
  // içində təsadüfən görünür və substring axtarışı onları səhv tutur.
  it('hex cf-ray içindəki təsadüfi "401"-i auth saymır', () => {
    const real =
      'unexpected status 429 Too Many Requests, url: wss://api.openai.com/v1/responses, cf-ray: a2140175bd9ce8ee-GYD'
    expect(real).toContain('401') // substring HƏQİQƏTƏN var
    expect(classifyErrorText(real)).toBe('rate_limit')
  })

  it('UUID request-id içindəki təsadüfi kodu auth saymır', () => {
    expect(
      classifyErrorText(
        'Error: model is overloaded, request id: req_00000000-4030-1000-8000-000000000001',
      ),
    ).toBe('overloaded')
  })

  it('müddət rəqəmini status kodu kimi tutmur', () => {
    expect(classifyErrorText('Request timed out after 401 seconds')).toBe(
      'timeout',
    )
  })

  it('abunəlik limiti mesajını rate_limit kimi tanıyır', () => {
    expect(classifyErrorText('You have reached your usage limit')).toBe(
      'rate_limit',
    )
  })
})

describe('isRetryable', () => {
  // Hər sinif üçün açıq cədvəl. Yeni sinif əlavə olunsa və bu cədvəl
  // yenilənməsə, aşağıdaki tamlıq testi sınacaq.
  const EXPECTED: Record<ErrorClass, boolean> = {
    auth: false,
    budget_exceeded: false,
    tool_denied: false,
    parse_error: false,
    rate_limit: true,
    overloaded: true,
    timeout: true,
    crashed: true,
  }

  for (const cls of ERROR_CLASSES) {
    it(`${cls} → retryable: ${EXPECTED[cls]}`, () => {
      expect(isRetryable(cls)).toBe(EXPECTED[cls])
    })
  }

  it('hər sinif cədvəldə var — tamlıq yoxlaması', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ERROR_CLASSES].sort())
  })
})

describe('ERROR_CLASSES', () => {
  it('spesifikasiyadaki 8 sinfi ehtiva edir', () => {
    expect([...ERROR_CLASSES].sort()).toEqual([
      'auth',
      'budget_exceeded',
      'crashed',
      'overloaded',
      'parse_error',
      'rate_limit',
      'timeout',
      'tool_denied',
    ])
  })
})
