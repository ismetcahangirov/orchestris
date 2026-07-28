import { describe, expect, it } from 'vitest'
import { CreateTaskBody } from './api.js'

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
