import { describe, expect, it } from 'vitest'
import { classifyErrorText, ERROR_CLASSES, isRetryable } from './errors.js'

describe('classifyErrorText', () => {
  it('401 mesajını auth kimi tanıyır', () => {
    expect(
      classifyErrorText('unexpected status 401 Unauthorized: Missing bearer'),
    ).toBe('auth')
  })

  it('"Not logged in" mesajını auth kimi tanıyır', () => {
    expect(classifyErrorText('Not logged in')).toBe('auth')
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
})

describe('isRetryable', () => {
  it('auth təkrar edilə bilməz — insan müdaxiləsi lazımdır', () => {
    expect(isRetryable('auth')).toBe(false)
  })

  it('budget_exceeded təkrar edilə bilməz — sərt kəsimdir', () => {
    expect(isRetryable('budget_exceeded')).toBe(false)
  })

  it('rate_limit təkrar edilə bilər', () => {
    expect(isRetryable('rate_limit')).toBe(true)
  })

  it('overloaded təkrar edilə bilər', () => {
    expect(isRetryable('overloaded')).toBe(true)
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
