import type { McpServerRow, PluginRow } from '../lib/api.js'

interface Props {
  contextId: string
  mcpServers: readonly McpServerRow[]
  plugins: readonly PluginRow[]
  selectedMcpIds: readonly string[]
  selectedPluginIds: readonly string[]
  builtinSkillsEnabled: boolean
  onSave: (patch: {
    mcpServerIds?: string[]
    pluginIds?: string[]
    builtinSkillsEnabled?: boolean
  }) => void
}

function toggle(list: readonly string[], id: string, on: boolean): string[] {
  return on ? [...list, id] : list.filter((x) => x !== id)
}

/**
 * Kontekstin MCP / plugin / daxili skill seçimi (Faza 5C).
 *
 * Qiymət xəbərdarlığı ÖLÇÜLMÜŞ rəqəmlərlə verilir, təxminlə yox — və
 * ölçülməyən şey (plugin) açıq şəkildə "ölçülməyib" yazılır.
 */
export default function CustomizationPanel({
  contextId,
  mcpServers,
  plugins,
  selectedMcpIds,
  selectedPluginIds,
  builtinSkillsEnabled,
  onSave,
}: Props): React.JSX.Element {
  const anySelected =
    selectedMcpIds.length > 0 || selectedPluginIds.length > 0 || builtinSkillsEnabled

  return (
    <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
      <div className="text-xs font-medium text-ink-dim">Fərdiləşdirmə (MCP / skill)</div>

      {mcpServers.length === 0 && plugins.length === 0 && (
        <p className="text-xs text-ink-dim">
          Hələ MCP serveri və ya plugin əlavə edilməyib — «Fərdiləşdirmə»
          səhifəsinə keçin.
        </p>
      )}

      {mcpServers.length > 0 && (
        <div>
          <div className="text-xs text-ink-dim">MCP serverləri</div>
          {mcpServers.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={s.name}
                checked={selectedMcpIds.includes(s.id)}
                onChange={(e) =>
                  onSave({ mcpServerIds: toggle(selectedMcpIds, s.id, e.target.checked) })
                }
              />
              {s.name}
              <span className="text-xs text-ink-dim">{s.transport}</span>
            </label>
          ))}
        </div>
      )}

      {plugins.length > 0 && (
        <div>
          <div className="text-xs text-ink-dim">Plugin / skill dəstləri</div>
          {plugins.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={p.name}
                checked={selectedPluginIds.includes(p.id)}
                onChange={(e) =>
                  onSave({ pluginIds: toggle(selectedPluginIds, p.id, e.target.checked) })
                }
              />
              {p.name}
            </label>
          ))}
        </div>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name={`builtin-${contextId}`}
          aria-label="CLI-nin daxili skill dəsti"
          checked={builtinSkillsEnabled}
          onChange={(e) => onSave({ builtinSkillsEnabled: e.target.checked })}
        />
        <span>
          CLI-nin daxili skill dəsti
          {/* Hamısı-birdən: CLI-də ədəd-ədəd söndürmə bayrağı YOXDUR. */}
          <span className="ml-2 text-xs text-ink-dim">
            hamısı-birdən · ölçülmüş +3,648 token / icra
          </span>
        </span>
      </label>

      {anySelected && (
        <div className="rounded border border-warn/30 bg-warn/5 p-2 text-xs text-ink-dim">
          <p>
            <strong>Ölçülmüş qiymət:</strong> fərdiləşdirmə açıq olan kontekst
            fərqli bayraq dəsti ilə işləyir — prompt keşi BİR DƏFƏ yenidən
            qurulur. Bir kiçik MCP serveri üçün sabit əlavə +3,004 token
            (+12.5%). Plugin-lərin qiyməti <strong>ölçülməyib</strong> və
            plugin-in ölçüsündən asılıdır.
          </p>
          <p className="mt-1">
            <strong>Diqqət:</strong> bu seçim yalnız <code>cli:claude</code>{' '}
            icralarında tətbiq olunur. <code>cli:codex</code> üçün yol
            ölçülmədiyi üçün dəstəklənmir — task ora düşsə MCP/skill olmayacaq.
          </p>
        </div>
      )}
    </div>
  )
}
