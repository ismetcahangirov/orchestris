import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerRow, PluginRow } from '../lib/api.js'
import CustomizationPanel from './CustomizationPanel.js'

const SERVER: McpServerRow = {
  id: 'm1',
  name: 'context7',
  transport: 'stdio',
  command: 'npx',
  args: [],
  env: {},
  secretEnvNames: [],
  hasSecret: false,
  url: null,
  enabled: true,
  createdAt: 1,
}

const PLUGIN: PluginRow = { id: 'p1', name: 'superpowers', path: '/plug', createdAt: 1 }

function panel(over: Partial<Parameters<typeof CustomizationPanel>[0]> = {}) {
  const onSave = vi.fn()
  render(
    <CustomizationPanel
      contextId="c1"
      mcpServers={[SERVER]}
      plugins={[PLUGIN]}
      selectedMcpIds={[]}
      selectedPluginIds={[]}
      builtinSkillsEnabled={false}
      onSave={onSave}
      {...over}
    />,
  )
  return onSave
}

describe('CustomizationPanel', () => {
  it('MCP serverini checkbox kimi göstərir', () => {
    panel()
    expect(screen.getByLabelText('context7')).not.toBeChecked()
  })

  it('seçim onSave-ə TAM siyahı ilə gedir', () => {
    const onSave = panel()
    fireEvent.click(screen.getByLabelText('context7'))
    expect(onSave).toHaveBeenCalledWith({ mcpServerIds: ['m1'] })
  })

  it('seçimin ləğvi siyahıdan çıxarır', () => {
    const onSave = panel({ selectedMcpIds: ['m1'] })
    fireEvent.click(screen.getByLabelText('context7'))
    expect(onSave).toHaveBeenCalledWith({ mcpServerIds: [] })
  })

  it('plugin seçimi ayrıca gedir', () => {
    const onSave = panel()
    fireEvent.click(screen.getByLabelText('superpowers'))
    expect(onSave).toHaveBeenCalledWith({ pluginIds: ['p1'] })
  })

  it('daxili skill dəsti hamısı-birdən olduğunu yazır', () => {
    panel()
    expect(screen.getByText(/hamısı-birdən/)).toBeInTheDocument()
    expect(screen.getByText(/\+3,648 token/)).toBeInTheDocument()
  })

  it('heç nə seçilməyibsə xəbərdarlıq GÖRÜNMÜR', () => {
    panel()
    expect(screen.queryByText(/Ölçülmüş qiymət/)).not.toBeInTheDocument()
  })

  it('seçim varsa ÖLÇÜLMÜŞ qiymət göstərilir', () => {
    panel({ selectedMcpIds: ['m1'] })
    expect(screen.getByText(/\+3,004 token/)).toBeInTheDocument()
    expect(screen.getByText(/\+12\.5%/)).toBeInTheDocument()
  })

  it('plugin qiymətinin ÖLÇÜLMƏDİYİ açıq yazılır', () => {
    panel({ selectedPluginIds: ['p1'] })
    expect(screen.getByText(/ölçülməyib/)).toBeInTheDocument()
  })

  it('codex-in dəstəkləmədiyi açıq yazılır', () => {
    panel({ builtinSkillsEnabled: true })
    expect(screen.getByText(/cli:codex/)).toBeInTheDocument()
  })

  it('kataloq boşdursa istiqamət verilir', () => {
    panel({ mcpServers: [], plugins: [] })
    expect(screen.getByText(/Fərdiləşdirmə.*səhifəsinə/)).toBeInTheDocument()
  })
})
