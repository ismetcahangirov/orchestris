import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import AddProvider from '../components/AddProvider.js'
import ModelList from '../components/ModelList.js'
import { api, type ApiProviderRow, type CliProviderRow } from '../lib/api.js'

function CredentialForm({
  provider,
  onDone,
}: {
  provider: ApiProviderRow
  onDone: () => void
}): React.JSX.Element {
  // Açar YALNIZ bu komponentin lokal state-indədir və göndərildikdən sonra
  // dərhal silinir. React Query keşinə, localStorage-a və ya URL-ə DÜŞMÜR.
  const [apiKey, setApiKey] = useState('')

  const save = useMutation({
    mutationFn: () => api.setCredential(provider.id, apiKey),
    onSettled: () => {
      setApiKey('')
      onDone()
    },
  })

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (apiKey.length >= 8) save.mutate()
      }}
    >
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={`${provider.displayName} API açarı`}
        placeholder="API açarı"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        className="min-w-0 flex-1 rounded border border-white/10 bg-surface px-2 py-1 font-mono text-sm"
      />
      <button
        type="submit"
        disabled={apiKey.length < 8 || save.isPending}
        className="rounded bg-accent/20 px-3 py-1 text-sm text-accent disabled:opacity-40"
      >
        {save.isPending ? 'Yoxlanılır…' : 'Yadda saxla'}
      </button>
      {provider.envVars.length > 0 && (
        <span className="w-full font-mono text-xs text-ink-dim">
          OS anbarında saxlanılır · {provider.envVars.join(' / ')}
        </span>
      )}
    </form>
  )
}

/**
 * Lokal CLI runner-i.
 *
 * Model siyahısı burada da göstərilir: Auto rejimi YALNIZ "işçi" işarəli
 * modellər arasından seçir, ona görə CLI modellərinə rol verə bilmək
 * routing-in əsas qaydasının ("fayl işi → CLI") ön şərtidir. CLI modelləri
 * models.dev kataloqundan seed olunur — açar tələb olunmur.
 */
function CliProviderCard({ provider }: { provider: CliProviderRow }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-lg border border-white/10 bg-surface-2 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="font-mono text-sm font-medium">{provider.id}</div>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            provider.authenticated
              ? 'bg-good/15 text-good'
              : provider.installed
                ? 'bg-warn/15 text-warn'
                : 'bg-bad/15 text-bad'
          }`}
        >
          {provider.authenticated
            ? 'hazır'
            : provider.installed
              ? 'login lazımdır'
              : 'quraşdırılmayıb'}
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-dim">{provider.detail}</p>
      {provider.version !== undefined && (
        <p className="mt-1 font-mono text-xs text-ink-dim">{provider.version}</p>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-3 rounded bg-white/5 px-3 py-1 text-sm text-ink-dim hover:text-ink"
      >
        Modellər {open ? '▲' : '▼'}
      </button>
      {open && <ModelList providerId={provider.id} />}
    </div>
  )
}

function ApiProviderCard({ provider }: { provider: ApiProviderRow }): React.JSX.Element {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['providers'] })
    void qc.invalidateQueries({ queryKey: ['models'] })
  }

  const remove = useMutation({
    mutationFn: () => api.deleteCredential(provider.id),
    onSuccess: invalidate,
  })
  const rediscover = useMutation({
    mutationFn: () => api.discoverModels(provider.id),
    onSuccess: invalidate,
  })

  return (
    <div className="rounded-lg border border-white/10 bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-medium">{provider.displayName}</span>
          <span className="ml-2 font-mono text-xs text-ink-dim">{provider.id}</span>
        </div>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            provider.hasCredential ? 'bg-good/15 text-good' : 'bg-ink-dim/15 text-ink-dim'
          }`}
        >
          {provider.hasCredential ? 'açar təyin olunub' : 'açar yoxdur'}
        </span>
      </div>

      {provider.hasCredential ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <button
              onClick={() => setOpen((v) => !v)}
              className="rounded bg-white/5 px-3 py-1 text-ink-dim hover:text-ink"
            >
              {provider.modelCount} model {open ? '▲' : '▼'}
            </button>
            <button
              onClick={() => rediscover.mutate()}
              disabled={rediscover.isPending}
              className="rounded bg-white/5 px-3 py-1 text-ink-dim hover:text-ink disabled:opacity-40"
            >
              {rediscover.isPending ? 'Kəşf edilir…' : 'Yenidən kəşf et'}
            </button>
            <button
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="rounded bg-bad/10 px-3 py-1 text-bad disabled:opacity-40"
            >
              Açarı sil
            </button>
          </div>
          {open && <ModelList providerId={provider.id} />}
        </>
      ) : (
        <CredentialForm provider={provider} onDone={invalidate} />
      )}

      {provider.lastDiscoveryError !== null && (
        <p className="mt-2 rounded bg-bad/10 px-2 py-1 font-mono text-xs text-bad">
          Son kəşf xətası: {provider.lastDiscoveryError}
        </p>
      )}
    </div>
  )
}

export default function Providers(): React.JSX.Element {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['providers'],
    queryFn: api.listProviders,
  })

  const refresh = useMutation({
    mutationFn: api.refreshCatalog,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers'] }),
  })

  if (isLoading) return <p className="text-ink-dim">Aşkarlanır…</p>
  if (error !== null) return <p className="text-bad">{String(error)}</p>

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Provayderlər</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Lokal CLI-lar avtomatik aşkarlanır və abunəlikdən işləyir. API açarları OS-in
        öz anbarında saxlanılır — fayla və ya bazaya heç vaxt yazılmır.
      </p>

      {data?.keychain.ok === false && (
        <p className="mb-4 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {data.keychain.detail}
        </p>
      )}

      <h2 className="mb-2 text-sm font-medium text-ink-dim">Lokal CLI</h2>
      <div className="mb-6 space-y-3">
        {data?.cli.map((p) => <CliProviderCard key={p.id} provider={p} />)}
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink-dim">API provayderləri</h2>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="text-xs text-ink-dim hover:text-ink disabled:opacity-40"
          title="models.dev-dən qiymət və model siyahısını yenilə"
        >
          {refresh.isPending ? 'Yenilənir…' : 'Kataloqu yenilə'}
        </button>
      </div>
      <div className="mb-6 space-y-3">
        {data?.api.map((p) => <ApiProviderCard key={p.id} provider={p} />)}
      </div>

      <AddProvider />

      {data !== undefined && (
        <p className="mt-4 text-xs text-ink-dim">
          Kataloq mənbəyi:{' '}
          {data.catalog.source === 'bundled' ? 'repodakı snapshot (offline)' : 'models.dev'}
          {data.catalog.fetchedAt !== undefined &&
            ` · ${new Date(data.catalog.fetchedAt).toLocaleString('az')}`}
        </p>
      )}
      {refresh.isError && (
        <p className="mt-2 text-xs text-bad">Kataloq yenilənmədi — köhnə nüsxə işlədilir.</p>
      )}
    </div>
  )
}
