import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, CLAUDE_CUSTOM_FLAGS, CLAUDE_STABLE_FLAGS } from './claude.js'

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

describe('fayl icazəsi arqumentləri', () => {
  it('read-only səviyyəsi plan rejimi verir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      cwd: '/repo',
      fileAccess: { level: 'read-only', dirs: ['/repo'] },
    })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('workspace səviyyəsi acceptEdits verir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      cwd: '/repo',
      fileAccess: { level: 'workspace', dirs: ['/repo'] },
    })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('hər qovluq üçün ayrıca --add-dir verilir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      cwd: '/repo',
      fileAccess: { level: 'extended', dirs: ['/a', '/repo'] },
    })
    const dirs = args.filter((_, i) => args[i - 1] === '--add-dir')
    expect(dirs).toEqual(['/a', '/repo'])
  })

  it('fileAccess verilməsə köhnə davranış qalır', () => {
    const args = buildClaudeArgs(
      { prompt: 'p', model: 'm', cwd: '/repo' },
      { permissionMode: 'acceptEdits' },
    )
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/repo')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('CLAUDE_STABLE_FLAGS DƏYİŞMİR — qayda 1', () => {
    // Qəsdən sərt test: dəstə bir bayraq əlavə etmək bütün mövcud prompt
    // keşlərini bir dəfəlik sındırır (ölçülmüş: $0.0085 → $0.0444).
    expect([...CLAUDE_STABLE_FLAGS]).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--safe-mode',
      '--strict-mcp-config',
      '--exclude-dynamic-system-prompt-sections',
      '--disable-slash-commands',
    ])
  })
})

describe('CLAUDE_CUSTOM_FLAGS — fərdiləşdirmə dəsti (Faza 5C)', () => {
  it('--safe-mode DAŞIMIR, --setting-sources daşıyır', () => {
    // ÖLÇÜLDÜ: `--safe-mode`-u sadəcə çıxarmaq promptu 23k → 76k edir və keşi
    // TAM sındırır ($0.1528). `--setting-sources ''` bunu +12.5%-ə endirir.
    expect(CLAUDE_CUSTOM_FLAGS).not.toContain('--safe-mode')
    expect(CLAUDE_CUSTOM_FLAGS).toContain('--setting-sources')
  })

  it('--strict-mcp-config HƏR İKİ dəstdə qalır', () => {
    // İstifadəçinin qlobal MCP konfiqurasiyası heç vaxt səssizcə sızmamalıdır.
    expect(CLAUDE_STABLE_FLAGS).toContain('--strict-mcp-config')
    expect(CLAUDE_CUSTOM_FLAGS).toContain('--strict-mcp-config')
  })

  it('--disable-slash-commands SABİT dəstdədir, fərdi dəstdə YOX', () => {
    expect(CLAUDE_STABLE_FLAGS).toContain('--disable-slash-commands')
    expect(CLAUDE_CUSTOM_FLAGS).not.toContain('--disable-slash-commands')
  })

  it('customizations YOXDURSA əmr sətri SABİT dəstlə qurulur', () => {
    const args = buildClaudeArgs({ prompt: 'p', model: 'm' })
    expect(args).toContain('--safe-mode')
    expect(args).not.toContain('--setting-sources')
    expect(args).not.toContain('--mcp-config')
  })

  it('customizations VARSA safe-mode getmir, mcp-config gəlir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      customizations: { mcpConfigPath: '/cfg.json', pluginDirs: [], builtinSkills: false },
    })
    expect(args).not.toContain('--safe-mode')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/cfg.json')
  })

  it('hər plugin üçün ayrıca --plugin-dir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      customizations: { pluginDirs: ['/a', '/b'], builtinSkills: false },
    })
    expect(args.filter((_, i) => args[i - 1] === '--plugin-dir')).toEqual(['/a', '/b'])
  })

  it('builtinSkills true olanda --disable-slash-commands OLMUR', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      customizations: { pluginDirs: [], builtinSkills: true },
    })
    expect(args).not.toContain('--disable-slash-commands')
  })

  it('builtinSkills false olanda --disable-slash-commands QALIR', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      customizations: { pluginDirs: [], builtinSkills: false },
    })
    expect(args).toContain('--disable-slash-commands')
  })

  it('fayl icazəsi ilə birlikdə işləyir', () => {
    const args = buildClaudeArgs({
      prompt: 'p',
      model: 'm',
      cwd: '/repo',
      fileAccess: { level: 'workspace', dirs: ['/repo'] },
      customizations: { pluginDirs: [], builtinSkills: true },
    })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(args).not.toContain('--safe-mode')
  })
})
