import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixturePath, repoRoot } from './fixtures-path.js'

describe('repoRoot', () => {
  it('pnpm-workspace.yaml olan qovluğu tapır', () => {
    expect(existsSync(`${repoRoot()}/pnpm-workspace.yaml`)).toBe(true)
  })

  it('cwd-dən asılı deyil', () => {
    const before = repoRoot()
    const old = process.cwd()
    try {
      process.chdir('..')
      expect(repoRoot()).toBe(before)
    } finally {
      process.chdir(old)
    }
  })
})

describe('fixturePath', () => {
  it('mövcud fixture faylına işarə edir', () => {
    expect(existsSync(fixturePath('claude-safe-mode.jsonl'))).toBe(true)
  })
})
