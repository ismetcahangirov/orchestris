import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import ModelRolePanel from '../components/ModelRolePanel.js'
import { selectableModels } from '../lib/selectableModels.js'
import { summarizeBudget } from '../lib/budgetLabel.js'
import SavingsPanel from '../components/SavingsPanel.js'
import { api } from '../lib/api.js'

/** İşçi seçicisində "router özü seçsin" variantının dəyəri. */
const AUTO = 'auto'

interface RunnerOption {
  id: string
  label: string
  ready: boolean
  /** Hazır deyilsə səbəb — istifadəçi nə edəcəyini bilməlidir. */
  detail: string
}

export default function Dashboard(): React.JSX.Element {
  const navigate = useNavigate()
  const [contextId, setContextId] = useState('')
  // `auto` = Pillə 1 (qayda routing) işçini özü seçir.
  const [runner, setRunner] = useState('auto')
  // Boş sətir = "hələ seçilməyib". Əvvəllər burada SABİT KODLANMIŞ model adı
  // vardı (`claude-haiku-4-5-20251001`) — o, istifadəçinin quraşdırmasında
  // ümumiyyətlə olmaya bilərdi və task icra anında sınardı.
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  // Faza 4 — başçı taskı alt-tasklara bölsün. AÇIQ seçimdir: bölgü bir başçı
  // icrası + N nərdivan dövrəsi ödəyir, faydası isə hələ ölçülməyib.
  const [decompose, setDecompose] = useState(false)

  const { data: contexts } = useQuery({ queryKey: ['contexts'], queryFn: api.listContexts })
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders })
  // Eyni `queryKey` `ModelRolePanel`-də də işlədilir — react-query onu bir dəfə
  // yükləyib paylaşır, yəni ikinci sorğu getmir.
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: () => api.listModels() })
  const { data: savings } = useQuery({
    queryKey: ['savings', 'month'],
    queryFn: () => api.getSavings('month'),
  })

  const auto = runner === AUTO

  // Əl ilə seçimdə model siyahısı SEÇİLMİŞ RUNNER-ə görə süzülür: `api:openai`
  // seçib Anthropic modeli yazmaq mümkün olmamalıdır (əvvəlki sərbəst mətn
  // sahəsində məhz bu mümkün idi və səhv yalnız icra anında üzə çıxırdı).
  const modelChoices = selectableModels(models ?? [], providers).filter(
    (o) => o.runnerId === runner,
  )
  /**
   * Faktiki model — seçim TÖRƏMƏdir, ayrıca state deyil.
   *
   * Səbəb: runner dəyişəndə köhnə model artıq siyahıda olmaya bilər. State-i
   * `onChange`-də sinxronlaşdırsaydıq, modellər hələ yüklənməmiş runner
   * dəyişikliyi boş seçim buraxardı (yükləmə ilə klik arasında yarış). Törəmə
   * dəyər həmişə cari siyahıya uyğun gəlir.
   *
   * Əvvəlki davranış SABİT KODLANMIŞ ad idi (`claude-haiku-4-5-20251001`) — o,
   * istifadəçinin quraşdırmasında ümumiyyətlə olmaya bilərdi və səhv yalnız
   * icra anında üzə çıxardı.
   */
  const effectiveModel =
    model !== '' && modelChoices.some((o) => o.model.modelId === model)
      ? model
      : (modelChoices[0]?.model.modelId ?? '')
  // Seçiləcək model yoxdursa əl ilə icra göndərilə bilməz — server boş model
  // adını "əl ilə seçim" kimi oxuyardı və icra dərhal sınardı.
  const needsModel = !auto && effectiveModel === ''

  const submit = useMutation({
    mutationFn: () =>
      api.createTask({
        contextId,
        prompt,
        // Auto rejimində runner və model GÖNDƏRİLMİR — onları router seçir.
        // Boş sətir göndərsək server onu "əl ilə seçim" kimi oxuyardı.
        ...(auto ? {} : { runner, model: effectiveModel }),
        // `false` GÖNDƏRİLMİR: server sahənin YOXLUĞUNU "bölmə" kimi oxuyur və
        // hər sorğuya `decompose: false` qoymaq köhnə klientləri fərqləndirilməz
        // edərdi.
        ...(decompose ? { decompose: true } : {}),
        // LİMİT BURADA VERİLMİR — o, kontekstin ayarındadır.
        //
        // Əvvəl burada `maxOutputTokens: 30_000, maxSeconds: 600` SABİT
        // KODLANMIŞDI. İstifadəçi onu nə görürdü, nə dəyişə bilirdi; limit
        // dəyəndə isə ekranda yalnız `failed` görünürdü. Ölçülmüş nəticə
        // (2026-08-01): altı parçaya bölünmüş task 600-cü saniyədə öldü,
        // parçaların dördü bir icra belə etmədən atıldı.
        //
        // Kontekstdəki dəyər `POST /api/tasks`-da tətbiq olunur; sahə boşdursa
        // limit ÜMUMİYYƏTLƏ yoxdur. Aşağıda həmin dəyər göndərməzdən ƏVVƏL
        // göstərilir.
      }),
    onSuccess: (r) => navigate(`/tasks/${r.taskId}`),
  })

  // İşçi siyahısı serverdən gəlir — sabit kodlanmış deyil. CLI runner-ləri
  // PATH-dan aşkarlanır, API runner-ləri isə açarı olan provayderlərdən.
  // ÖLÇÜLMÜŞ FƏRQ (Faza 1A): `claude` CLI hər çağırışda ~21.7k token döşəməsi
  // daşıyır, API-nın döşəməsi ~0-dır — amma API-də real pul çıxır. Auto məhz
  // bu fərqə görə seçim edir (Pillə 1 qaydaları).
  const options: RunnerOption[] = [
    {
      id: AUTO,
      label: 'Auto (router seçir)',
      // Auto-nun hazırlığı serverdə yoxlanılır: uyğun işçi yoxdursa task
      // səbəbi ilə uğursuz olur və səbəb `/tasks/:id` səhifəsində görünür.
      ready: true,
      detail: '',
    },
    ...(providers?.cli ?? []).map((p) => ({
      id: p.id,
      label: `${p.id} (abunəlik)`,
      ready: p.authenticated,
      detail: p.detail,
    })),
    ...(providers?.api ?? [])
      .filter((p) => p.runnerId !== null)
      .map((p) => ({
        id: p.runnerId as string,
        label: `${p.runnerId} (real pul)`,
        ready: p.authenticated,
        detail: p.hasCredential
          ? 'Açar var, amma anbardan oxunmadı — /providers səhifəsindən yenidən əlavə et'
          : 'API açarı təyin olunmayıb — /providers səhifəsindən əlavə et',
      })),
  ]

  const selected = options.find((o) => o.id === runner)
  const blocked = selected !== undefined && !selected.ready

  // Limit GÖNDƏRMƏZDƏN ƏVVƏL göstərilir: sonradan göstərmək "task niyə
  // dayandı?" sualını yaradır, əvvəlcədən göstərmək isə onu heç yaratmır.
  const budget = summarizeBudget(contexts?.find((c) => c.id === contextId))


  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">İdarə paneli</h1>
      <p className="mb-6 text-sm text-ink-dim">Yeni task başlat və canlı izlə.</p>

      <ModelRolePanel />

      <form
        className="space-y-4 rounded-lg border border-white/10 bg-surface-2 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (contextId !== '' && prompt.trim() !== '' && !blocked && !needsModel) {
            submit.mutate()
          }
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            Kontekst
            <select
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">— seç —</option>
              {contexts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-dim">
            İşçi
            <select
              value={runner}
              onChange={(e) => setRunner(e.target.value)}
              className="w-56 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          {!auto && (
            <label className="flex flex-col gap-1 text-xs text-ink-dim">
              Model
              <select
                value={effectiveModel}
                onChange={(e) => setModel(e.target.value)}
                className="w-72 rounded border border-white/15 bg-surface px-3 py-2 font-mono text-sm text-ink"
              >
                {modelChoices.map((o) => (
                  <option key={o.model.id} value={o.model.modelId}>
                    {o.model.modelId}
                  </option>
                ))}
              </select>
              {modelChoices.length === 0 && (
                <span className="text-warn">
                  Bu runner üçün aktiv model yoxdur — /providers səhifəsinə bax
                </span>
              )}
            </label>
          )}
        </div>

        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          Task
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Bu funksiyaya test yaz…"
            className="w-full rounded border border-white/15 bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        <label className="flex items-start gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={decompose}
            onChange={(e) => setDecompose(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Böyük taskı alt-tasklara böl
            <span className="block text-ink-dim/70">
              Başçı bir dəfə bölgü yazır, hər parça ayrıca nərdivandan keçir.
              Bir başçı icrası + parça sayı qədər dövrə ödənilir — yalnız
              həqiqətən böyük tasklarda özünü ödəyir. Hər parça büdcəni TAM
              alır, yəni xərc parça sayına görə artır.
            </span>
          </span>
        </label>

        {contextId !== '' && (
          <p className="text-xs text-ink-dim">
            Büdcə:{' '}
            <span className={budget.unlimited ? 'text-warn' : 'text-ink'}>
              {budget.text}
            </span>{' '}
            · limit aşılsa task DAYANMIR, yalnız qeyd olunur{' '}
            <Link to="/contexts" className="text-accent hover:underline">
              dəyiş
            </Link>
          </p>
        )}

        {blocked && (
          <p className="text-sm text-warn">{`${runner} hazır deyil: ${selected?.detail ?? ''}`}</p>
        )}

        {contexts?.length === 0 && (
          <p className="text-sm text-warn">
            Əvvəlcə Kontekstlər səhifəsində bir kontekst yarat.
          </p>
        )}

        <button
          type="submit"
          disabled={
            contextId === '' || prompt.trim() === '' || blocked || needsModel || submit.isPending
          }
          className="rounded bg-accent/20 px-4 py-2 text-sm text-accent disabled:opacity-40"
        >
          {submit.isPending ? 'Başladılır…' : 'İşə sal'}
        </button>

        {submit.error !== null && <p className="text-sm text-bad">{String(submit.error)}</p>}
      </form>

      <div className="mt-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-ink-dim">Son ayın qənaəti</h2>
          <Link to="/history" className="text-xs text-ink-dim hover:text-ink">
            Tarixçə →
          </Link>
        </div>
        {savings !== undefined && <SavingsPanel summary={savings.summary} />}
      </div>
    </div>
  )
}
