import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import FolderPicker from '../components/FolderPicker.js'
import { api } from '../lib/api.js'

/**
 * MCP serverləri və plugin/skill dəstləri (Faza 5C).
 *
 * Burada YALNIZ kataloq idarə olunur; hansı kontekstin nəyi işlətdiyi
 * `/contexts` səhifəsindədir. Ayırma qəsdəndir: eyni server bir neçə
 * kontekstdə işlədilə bilər və onu hər kontekstdə yenidən yazmaq mənasızdır.
 */
export default function Customizations(): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [secretName, setSecretName] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [pluginName, setPluginName] = useState('')
  const [pluginPath, setPluginPath] = useState('')
  const [picking, setPicking] = useState(false)

  const servers = useQuery({ queryKey: ['mcp-servers'], queryFn: api.listMcpServers })
  const available = useQuery({
    queryKey: ['mcp-servers', 'available'],
    queryFn: api.listAvailableMcpServers,
  })
  const plugins = useQuery({ queryKey: ['plugins'], queryFn: api.listPlugins })

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['mcp-servers'] })
    void qc.invalidateQueries({ queryKey: ['plugins'] })
  }

  const addServer = useMutation({ mutationFn: api.createMcpServer, onSuccess: invalidate })
  const removeServer = useMutation({ mutationFn: api.deleteMcpServer, onSuccess: invalidate })
  const addPlugin = useMutation({ mutationFn: api.createPlugin, onSuccess: invalidate })
  const removePlugin = useMutation({ mutationFn: api.deletePlugin, onSuccess: invalidate })

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Fərdiləşdirmə</h1>
      <p className="mb-4 text-sm text-ink-dim">
        MCP serverləri və plugin/skill dəstləri. Buraya əlavə etmək onları
        AVTOMATİK açmır — hər kontekstdə ayrıca seçilir.
      </p>

      <div className="mb-6 rounded border border-warn/30 bg-warn/5 p-3 text-xs text-ink-dim">
        <strong>Niyə seçmə:</strong> ölçülüb ki, istifadəçinin bütün
        MCP/skill yükünü açmaq promptu 23k → 76k token edir və icranı 3x
        bahalaşdırır. Seçilmiş bir kiçik server isə cəmi +3,004 token (+12.5%)
        tutur. Ona görə burada hər şey ƏDƏD-ƏDƏD seçilir.
      </div>

      <h2 className="mb-2 text-sm font-semibold">MCP serverləri</h2>
      <ul className="mb-3 space-y-1">
        {(servers.data?.servers ?? []).map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-2 rounded border border-white/10 bg-surface-2 px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">
              {s.name}
              <span className="ml-2 text-xs text-ink-dim">{s.transport}</span>
              {s.hasSecret && (
                <span className="ml-2 text-xs text-good">
                  sirr: {s.secretEnvNames.join(', ')}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => removeServer.mutate(s.id)}
              className="shrink-0 text-xs text-ink-dim hover:text-bad"
            >
              sil
            </button>
          </li>
        ))}
        {servers.data?.servers.length === 0 && (
          <li className="text-sm text-ink-dim">Hələ server yoxdur.</li>
        )}
      </ul>
      {removeServer.error !== null && (
        <p className="mb-3 text-sm text-bad">{String(removeServer.error)}</p>
      )}

      {(available.data?.servers ?? []).some((s) => !s.added) && (
        <div className="mb-4">
          <div className="mb-1 text-xs text-ink-dim">
            <code>~/.claude.json</code>-dan tapıldı — bir kliklə əlavə edin
            (sirlər oxunmur, lazımdırsa özünüz yazın):
          </div>
          <div className="flex flex-wrap gap-2">
            {(available.data?.servers ?? [])
              .filter((s) => !s.added)
              .map((s) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() =>
                    addServer.mutate({
                      name: s.name,
                      transport: s.transport as 'stdio' | 'http' | 'sse',
                      ...(s.command !== null ? { command: s.command } : {}),
                      ...(s.url !== null ? { url: s.url } : {}),
                    })
                  }
                  className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5"
                >
                  + {s.name}
                </button>
              ))}
          </div>
        </div>
      )}

      <form
        className="mb-8 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() === '' || command.trim() === '') return
          addServer.mutate({
            name: name.trim(),
            transport: 'stdio',
            command: command.trim(),
            args: args.trim() === '' ? [] : args.trim().split(/\s+/),
            ...(secretName.trim() !== '' && secretValue !== ''
              ? { secretEnv: { [secretName.trim()]: secretValue } }
              : {}),
          })
          setName('')
          setCommand('')
          setArgs('')
          setSecretName('')
          setSecretValue('')
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Ad
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="context7"
            className="w-36 rounded border border-white/15 bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Əmr
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx"
            className="w-28 rounded border border-white/15 bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Arqumentlər
          <input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="-y @upstash/context7-mcp"
            className="w-56 rounded border border-white/15 bg-surface px-2 py-1.5 font-mono text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Sirr adı (ops.)
          <input
            value={secretName}
            onChange={(e) => setSecretName(e.target.value)}
            placeholder="API_KEY"
            className="w-28 rounded border border-white/15 bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Sirr dəyəri
          {/* Dəyər YALNIZ bu istiqamətdə hərəkət edir: brauzer → server →
              OS keychain. Heç bir cavabda geri qaytarılmır (qayda 13). */}
          <input
            type="password"
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            className="w-36 rounded border border-white/15 bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={addServer.isPending}
          className="rounded bg-accent/20 px-3 py-1.5 text-sm text-accent disabled:opacity-40"
        >
          Əlavə et
        </button>
      </form>
      {addServer.error !== null && (
        <p className="mb-4 text-sm text-bad">{String(addServer.error)}</p>
      )}

      <h2 className="mb-2 text-sm font-semibold">Plugin / skill dəstləri</h2>
      <ul className="mb-3 space-y-1">
        {(plugins.data?.plugins ?? []).map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-2 rounded border border-white/10 bg-surface-2 px-3 py-2 text-sm"
          >
            <span className="min-w-0">
              {p.name}
              <span className="ml-2 truncate font-mono text-xs text-ink-dim">{p.path}</span>
            </span>
            <button
              type="button"
              onClick={() => removePlugin.mutate(p.id)}
              className="shrink-0 text-xs text-ink-dim hover:text-bad"
            >
              sil
            </button>
          </li>
        ))}
        {plugins.data?.plugins.length === 0 && (
          <li className="text-sm text-ink-dim">Hələ plugin yoxdur.</li>
        )}
      </ul>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (pluginName.trim() === '' || pluginPath.trim() === '') return
          addPlugin.mutate({ name: pluginName.trim(), path: pluginPath.trim() })
          setPluginName('')
          setPluginPath('')
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Ad
          <input
            value={pluginName}
            onChange={(e) => setPluginName(e.target.value)}
            className="w-36 rounded border border-white/15 bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Qovluq və ya .zip
          <input
            value={pluginPath}
            onChange={(e) => setPluginPath(e.target.value)}
            className="w-72 rounded border border-white/15 bg-surface px-2 py-1.5 font-mono text-sm text-ink"
          />
        </label>
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="rounded border border-white/15 px-3 py-1.5 text-sm text-ink-dim hover:bg-white/5"
        >
          Seç…
        </button>
        <button
          type="submit"
          disabled={addPlugin.isPending}
          className="rounded bg-accent/20 px-3 py-1.5 text-sm text-accent disabled:opacity-40"
        >
          Əlavə et
        </button>
      </form>
      {addPlugin.error !== null && (
        <p className="mt-2 text-sm text-bad">{String(addPlugin.error)}</p>
      )}
      {removePlugin.error !== null && (
        <p className="mt-2 text-sm text-bad">{String(removePlugin.error)}</p>
      )}

      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        onSelect={(p) => {
          setPicking(false)
          setPluginPath(p)
        }}
      />
    </div>
  )
}
