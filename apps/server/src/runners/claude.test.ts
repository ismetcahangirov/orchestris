import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, CLAUDE_STABLE_FLAGS } from './claude.js'

describe('CLAUDE_STABLE_FLAGS', () => {
  it('--verbose daxildir — stream-json bunsuz xəta verir', () => {
    expect(CLAUDE_STABLE_FLAGS).toContain('--verbose')
  })

  it('--safe-mode daxildir — hook/skill/MCP overhead-ini söndürür', () => {
    expect(CLAUDE_STABLE_FLAGS).toContain('--safe-mode')
  })

  it('--bare DAXİL DEYİL — o, OAuth-u söndürür və abunəliyi sındırır', () => {
    expect(CLAUDE_STABLE_FLAGS).not.toContain('--bare')
  })

  it('--exclude-dynamic-system-prompt-sections daxildir — keş təkrar istifadəsi', () => {
    expect(CLAUDE_STABLE_FLAGS).toContain(
      '--exclude-dynamic-system-prompt-sections',
    )
  })

  it('stream-json formatı təyin olunub', () => {
    const i = CLAUDE_STABLE_FLAGS.indexOf('--output-format')
    expect(CLAUDE_STABLE_FLAGS[i + 1]).toBe('stream-json')
  })
})

describe('buildClaudeArgs — sabit prefiks', () => {
  it('sabit bayraqlar prompt-dan asılı olmayaraq eynidir', () => {
    // Prompt-cache-in qorunması buna bağlıdır: prefiks dəyişsə ~21.7k token
    // yenidən 1.25x tarifi ilə ödənilir (ölçülüb: 5x baha).
    const a = buildClaudeArgs({ prompt: 'p1', model: 'm' }, { sessionId: 'fixed' })
    const b = buildClaudeArgs({ prompt: 'p2', model: 'm' }, { sessionId: 'fixed' })
    const strip = (args: string[]): string[] =>
      args.filter((x) => x !== 'p1' && x !== 'p2')
    expect(strip(a)).toEqual(strip(b))
  })

  it('promptu heç vaxt sistem promptuna qoymur', () => {
    const args = buildClaudeArgs({ prompt: 'gizli task mətni', model: 'm' })
    expect(args).not.toContain('--system-prompt')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--system-prompt-file')
  })

  it('promptu -p bayrağından dərhal sonra ötürür', () => {
    const args = buildClaudeArgs({ prompt: 'salam', model: 'm' })
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('salam')
  })
})

describe('buildClaudeArgs — dəyişən hissələr', () => {
  it('model bayrağını əlavə edir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'claude-haiku-4-5-20251001' })
    const i = args.indexOf('--model')
    expect(args[i + 1]).toBe('claude-haiku-4-5-20251001')
  })

  it('cwd verildikdə --add-dir əlavə edir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm', cwd: '/work/proj' })
    const i = args.indexOf('--add-dir')
    expect(args[i + 1]).toBe('/work/proj')
  })

  it('cwd verilmədikdə --add-dir əlavə etmir', () => {
    expect(buildClaudeArgs({ prompt: 'x', model: 'm' })).not.toContain('--add-dir')
  })

  it('resumeSessionId verildikdə --resume istifadə edir, --session-id yox', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm', resumeSessionId: 's-1' })
    const i = args.indexOf('--resume')
    expect(args[i + 1]).toBe('s-1')
    expect(args).not.toContain('--session-id')
  })

  it('resume yoxdursa --session-id ilə verilmiş UUID-i işlədir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm' }, { sessionId: 'fixed-uuid' })
    const i = args.indexOf('--session-id')
    expect(args[i + 1]).toBe('fixed-uuid')
  })

  it('sessionId verilməsə etibarlı UUID yaradır', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm' })
    const i = args.indexOf('--session-id')
    expect(args[i + 1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it('permissionMode ötürülür', () => {
    const args = buildClaudeArgs(
      { prompt: 'x', model: 'm' },
      { permissionMode: 'acceptEdits' },
    )
    const i = args.indexOf('--permission-mode')
    expect(args[i + 1]).toBe('acceptEdits')
  })

  it('fallbackModel ötürülür', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm' }, { fallbackModel: 'sonnet' })
    const i = args.indexOf('--fallback-model')
    expect(args[i + 1]).toBe('sonnet')
  })
})

describe('buildClaudeArgs — hərf-hərf axın', () => {
  it('default olaraq --include-partial-messages əlavə edir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm' })
    expect(args).toContain('--include-partial-messages')
  })

  it('açıq şəkildə söndürülə bilir', () => {
    const args = buildClaudeArgs({ prompt: 'x', model: 'm' }, { partialMessages: false })
    expect(args).not.toContain('--include-partial-messages')
  })

  it('dondurulmuş bayraq dəstinə GİRMİR', () => {
    // Qayda 1: `CLAUDE_STABLE_FLAGS` dəyişməzdir. Bayraq ayrıca əlavə olunur
    // ki, konfiqurasiya ilə söndürülə bilsin və dəst dondurulmuş qalsın.
    expect(CLAUDE_STABLE_FLAGS).not.toContain('--include-partial-messages')
  })

  it('prefiksi hər iki rejimdə sabit saxlayır', () => {
    const withFlag = buildClaudeArgs({ prompt: 'p', model: 'm' }, { sessionId: 'f' })
    const without = buildClaudeArgs(
      { prompt: 'p', model: 'm' },
      { sessionId: 'f', partialMessages: false },
    )
    // Fərq YALNIZ bir bayraqdır — başqa heç nə sürüşmür.
    expect(withFlag.filter((a) => a !== '--include-partial-messages')).toEqual(without)
  })
})
