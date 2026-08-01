import {
  AMPLIFICATION_PROFILES,
  AnswerQuestionBody,
  CreateReviewBody,
  CreateTaskBody,
  type Runner,
} from '@orchestris/shared'
import type { FastifyInstance } from 'fastify'
import { getDiffArtifact, listArtifacts, resolveArtifact } from '../db/artifact-repo.js'
import type { Db } from '../db/client.js'
import {
  answerQuestion,
  createReview,
  getQuestion,
  listPendingQuestions,
  listQuestions,
  listReviews,
  type Question,
} from '../db/interaction-repo.js'
import {
  listContextMcpServers,
  listContextPlugins,
} from '../db/customization-repo.js'
import { listMemoryOps } from '../db/memory-repo.js'
import {
  createTask,
  deleteCacheEntry,
  getContext,
  getTask,
  listEvents,
  listRunsForTask,
  listSubtasks,
  listVerifications,
} from '../db/repo.js'
import { latestRoutingDecision, listRoutingDecisions } from '../db/routing-repo.js'
import { listTemplates } from '../db/template-repo.js'
import type { BudgetLimits } from '../exec/budget.js'
import type { Decomposer } from '../exec/decomposer.js'
import { activeRungs, type Ladder, type LadderContext } from '../exec/ladder.js'
import type { TaskPool } from '../exec/pool.js'
import type { DbQuestionGate } from '../exec/question-gate.js'
import { answerProblem } from '../exec/ask.js'
import {
  buildMcpConfig,
  pluginDirsOf,
  resolveCustomizations,
  writeMcpConfig,
  type Customizations,
} from '../exec/customizations.js'
import { mcpSecretRef } from './customizations.js'
import type { RunSupervisor } from '../exec/supervisor.js'
import {
  detectBinaryFiles,
  resolveMaxParallel,
  type WorktreeManager,
} from '../exec/worktree.js'
import { mcpConfigDir } from '../paths.js'
import type { CredentialStore } from '../secrets/keychain.js'
import type { RunnerReadiness } from '../routing/readiness.js'
import { BUILTIN_RULES } from '../routing/rules.js'

export interface TaskRouteDeps {
  db: Db
  supervisor: RunSupervisor
  ladder: Ladder
  runners: ReadonlyMap<string, Runner>
  /** Auto rejimindən əvvəl runner-lərin auth vəziyyətini təzələyir. */
  readiness?: RunnerReadiness
  /** Kontekst başına paralellik hovuzu. Verilməsə tasklar hovuzsuz qaçır. */
  pool?: TaskPool
  /** Diff-in qəbulu/rəddi üçün. Verilməsə həmin route-lar 503 qaytarır. */
  worktrees?: WorktreeManager
  /**
   * Task dekompozisiyası (Faza 4). Verilməsə `decompose: true` sadəcə NƏZƏRƏ
   * ALINMIR və task adi nərdivandan keçir — bölgü optimallaşdırmadır, tələb
   * deyil (eyni prinsip: worktree izolyasiyası, qayda 41).
   */
  decomposer?: Decomposer
  /**
   * Sual qapısı (Faza 5B). Verilməsə cavab DB-yə yazılır, amma gözləyən icraya
   * ÇATMIR — cavab `delivered: false` qaytarır və istifadəçi bunu görür.
   */
  questions?: DbQuestionGate
  /**
   * MCP sirlərinin oxunması üçün (Faza 5C). Verilməsə sirli serverlər
   * konfiqurasiyaya DÜŞMÜR — yarımçıq `env` ilə server sınardı.
   */
  credentials?: CredentialStore
}

/**
 * Kontekstin fərdiləşdirməsini BİR DƏFƏ həll edir və MCP faylını yazır.
 *
 * Nərdivanın İÇİNDƏ etmirik: o, bir taskda bir neçə icra qaçırır və hər
 * birində faylı yenidən yazsaydıq paralel icralar eyni fayl üzərində yarışardı.
 *
 * `undefined` qaytarırsa runner köhnə bayraq dəstini işlədir və əmr sətri
 * bayt-bayt dəyişməz qalır (qayda 1).
 */
async function resolveContextCustomizations(
  db: Db,
  contextId: string,
  builtinSkills: boolean,
  credentials: CredentialStore | undefined,
): Promise<Customizations | undefined> {
  const servers = listContextMcpServers(db, contextId)
  const plugins = listContextPlugins(db, contextId)

  let mcpConfigPath: string | undefined
  if (servers.length > 0) {
    const secrets = new Map<string, string>()
    for (const s of servers) {
      for (const name of JSON.parse(s.secretEnvJson) as string[]) {
        const value = await credentials?.get(mcpSecretRef(s.id, name))
        if (value !== null && value !== undefined) {
          secrets.set(`${s.id}:${name}`, value)
        }
      }
    }
    const { config } = buildMcpConfig(servers, (id, name) => secrets.get(`${id}:${name}`))
    if (config !== null) {
      mcpConfigPath = writeMcpConfig(mcpConfigDir(), contextId, config)
    }
  }

  return resolveCustomizations({
    mcpConfigPath,
    pluginDirs: pluginDirsOf(plugins),
    builtinSkills,
  })
}

/** Kontekst sətrindən nərdivanın gözlədiyi obyekti qurur — BİR yerdə. */
function toLadderContext(ctx: {
  id: string
  cwd: string | null
  verifyCommandsJson: string
  amplificationProfile: string
  defaultWorkerModelId: string | null
  maxParallel: number
  memoryScope: string | null
  memoryEnabled: boolean
  fileAccess: string
  extraDirsJson: string
  questionsEnabled: boolean
}, customizations?: Customizations): LadderContext {
  return {
    id: ctx.id,
    cwd: ctx.cwd,
    verifyCommandsJson: ctx.verifyCommandsJson,
    amplificationProfile: ctx.amplificationProfile,
    defaultWorkerModelId: ctx.defaultWorkerModelId,
    maxParallel: ctx.maxParallel,
    memoryScope: ctx.memoryScope,
    memoryEnabled: ctx.memoryEnabled,
    fileAccess: ctx.fileAccess,
    extraDirsJson: ctx.extraDirsJson,
    questionsEnabled: ctx.questionsEnabled,
    ...(customizations !== undefined ? { customizations } : {}),
  }
}

export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  const { db, supervisor, ladder, runners } = deps

  app.get('/api/routing/rules', async () => ({
    // Qaydalar hazırda QURAŞDIRILMIŞDIR (kodda) — istifadəçi onları redaktə
    // edə bilmir. Amma görə bilməlidir: "niyə bu model seçildi?" sualının
    // cavabı buradadır.
    rules: BUILTIN_RULES.map((r) => ({
      id: r.id,
      description: r.description,
      prefer: r.prefer,
    })),
    profiles: AMPLIFICATION_PROFILES,
    // Hansı profil hansı pillələri açır. UI-da təkrar yazılsaydı iki mənbə
    // olardı və biri dəyişəndə səhifə səssizcə yalan danışardı — pillə dəsti
    // yalnız `ladder.ts`-dədir.
    profileRungs: Object.fromEntries(
      AMPLIFICATION_PROFILES.map((p) => [p, [...activeRungs(p)].sort((a, b) => a - b)]),
    ),
  }))

  /**
   * Prompt distilləsi — başçının bir dəfə yazdığı, sonsuz dəfə işlədilən
   * şablonlar.
   *
   * `uses` və `escalationsAfter` BİRLİKDƏ qaytarılır: yalnız istifadə sayını
   * göstərmək mexanizmi həmişə uğurlu kimi göstərərdi — halbuki şablon tətbiq
   * olunub, task yenə başçıya qalxa bilər. Mətnin özü də qaytarılır ki,
   * istifadəçi "başçı nə yazdı?" sualını yoxlaya bilsin.
   */
  app.get('/api/templates', async () => ({ templates: listTemplates(db) }))

  app.post('/api/tasks', async (req, reply) => {
    const parsed = CreateTaskBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })
    const body = parsed.data

    const ctx = getContext(db, body.contextId)
    if (ctx === undefined) {
      return reply.code(404).send({ error: 'Kontekst tapılmadı' })
    }

    // `model` verilibsə seçim ƏL İLƏdir; verilməyibsə Auto (Pillə 1) işə düşür.
    // Runner tək başına verilə bilər — o zaman model də tələb olunur, yoxsa
    // "hansı model?" sualına cavab yoxdur.
    const manualModel = body.model
    let runner: Runner | undefined
    if (manualModel !== undefined) {
      const runnerId = body.runner ?? [...runners.keys()][0]
      runner = runnerId !== undefined ? runners.get(runnerId) : undefined
      if (runner === undefined) {
        return reply.code(400).send({
          error: `Runner mövcud deyil: ${runnerId ?? '(yoxdur)'}`,
          available: [...runners.keys()],
        })
      }
    } else if (body.runner !== undefined) {
      return reply.code(400).send({
        error: 'runner verilibsə model də verilməlidir (Auto üçün hər ikisini buraxın)',
      })
    } else {
      // Auto: qərar verməzdən əvvəl runner-lərin auth vəziyyətini təzələyirik.
      // TTL keşi sayəsində bu, dəqiqədə bir dəfədən çox proses spawn etmir.
      await deps.readiness?.refresh()
    }

    const task = createTask(db, { contextId: body.contextId, prompt: body.prompt })

    // Sorğuda verilən limit kontekstin default-unu üstələyir.
    //
    // `enforcement: 'report'` — ƏL İLƏ göndərilən taskda limit ÖLÇÜdür, əyləc
    // deyil: token/xərc aşımı nə icranı kəsir, nə qalan alt-taskları atır (bax
    // `BUDGET_ENFORCEMENTS`). Vaxt limiti isə hər halda tətbiq olunur — o,
    // ilişmiş prosesi dayandıran yeganə mexanizmdir.
    //
    // Cədvəl və zəncir icraları BU YOLDAN KEÇMİR (`scheduler.ts`,
    // `workflow-engine.ts`) və orada default `'stop'` qalır: avtomatik icrada
    // baxan insan yoxdur və qaçmış xərc yalnız hesabda görünərdi (qayda 57).
    const limits: BudgetLimits = {
      enforcement: 'report',
      ...(body.maxOutputTokens !== undefined
        ? { maxOutputTokens: body.maxOutputTokens }
        : ctx.budgetTokens !== null
          ? { maxOutputTokens: ctx.budgetTokens }
          : {}),
      ...(body.maxSeconds !== undefined
        ? { maxSeconds: body.maxSeconds }
        : ctx.budgetSeconds !== null
          ? { maxSeconds: ctx.budgetSeconds }
          : {}),
      ...(body.maxCostUsd !== undefined
        ? { maxCostUsd: body.maxCostUsd }
        : ctx.budgetUsd !== null
          ? { maxCostUsd: ctx.budgetUsd }
          : {}),
    }

    const ladderContext = toLadderContext(
      ctx,
      await resolveContextCustomizations(
        db,
        ctx.id,
        ctx.builtinSkillsEnabled,
        deps.credentials,
      ),
    )
    // Hər ikisi birlikdə verilir və ya heç biri — Ladder bunu "əl ilə seçim"
    // və ya "Auto" kimi oxuyur.
    const manual =
      runner !== undefined && manualModel !== undefined
        ? { runner, model: manualModel }
        : {}

    const start = async (): Promise<unknown> => {
      // Dekompozisiya nərdivandan ƏVVƏL sınanır, amma onu ƏVƏZ ETMİR: bölgü
      // alınmasa (başçı yoxdur, JSON qaytarmadı, bir parça verdi) task adi
      // nərdivandan keçir. Bir orkestrasiya qərarının uğursuzluğu istifadəçinin
      // nəticəsini məhv etməməlidir (monoton qayda, qayda 32).
      if (deps.decomposer !== undefined && body.decompose === true) {
        const split = await deps.decomposer.run({
          task: { id: task.id, prompt: body.prompt },
          context: ladderContext,
          requested: true,
          ...manual,
          limits,
        })
        if (split.decomposed) return split
      }
      return ladder.run({
        task: { id: task.id, prompt: body.prompt },
        context: ladderContext,
        ...manual,
        limits,
      })
    }

    // İcra fon rejimində gedir — HTTP cavabı onu gözləmir. Vəziyyət WebSocket
    // və `GET /api/tasks/:id` vasitəsilə izlənilir.
    //
    // Hovuz limiti aşılıbsa task NÖVBƏDƏ gözləyir və `pending` statusunda qalır:
    // hovuzsuz halda istifadəçinin ard-arda göndərdiyi hər task dərhal öz CLI
    // prosesini açardı (bax `pool.ts`).
    const queued =
      deps.pool === undefined
        ? start()
        : deps.pool.run(ctx.id, resolveMaxParallel(ctx.maxParallel), start)

    void queued.catch((err: unknown) => {
      app.log.error({ err }, 'ladder.run tutulmamış xəta')
    })

    return reply.code(202).send({ taskId: task.id })
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = getTask(db, req.params.id)
    if (task === undefined) return reply.code(404).send({ error: 'Task tapılmadı' })

    return {
      task,
      // Pillə 1-in qərarı: "niyə bu model?" sualının cavabı. Qeyri-müəyyən
      // tasklarda bir neçə qərar ola bilər (klassifikator + fallback).
      routing: latestRoutingDecision(db, task.id) ?? null,
      routingHistory: listRoutingDecisions(db, task.id),
      // İzolyasiya edilmiş worktree-dəki dəyişiklik. `pending` sətir = diskdə
      // gözləyən iş; istifadəçi onu qəbul edənə qədər əsas repoya HEÇ NƏ
      // yazılmır.
      // `binaryFiles` CANLI hesablanır, sütunda saxlanılmır (issue #41): marker
      // saxlanılan diff mətninin İÇİNDƏDİR, yəni məzmun həqiqətin yeganə
      // mənbəyidir. Sütun əlavə etsəydik, mövcud sətirlərə yanlış "boş" dəyər
      // yazılardı və qəbul qapısı köhnə diff-lərdə səssizcə işləməzdi.
      artifacts: listArtifacts(db, task.id).map((a) => ({
        ...a,
        binaryFiles: detectBinaryFiles(a.content),
      })),
      // Dekompozisiya (Faza 4) — alt-task ağacı. Bölünməmiş taskda boş massiv.
      // Ayrıca endpoint kimi YOX: task səhifəsi onsuz da bu cavabı çəkir və
      // ikinci sorğu eyni məlumatın iki mənbəyini yaradardı.
      subtasks: listSubtasks(db, task.id),
      // Yaddaş əməliyyatları (Faza 3). `runs` ilə yanaşı verilir, ayrıca
      // endpoint kimi YOX: task səhifəsi onsuz da bu cavabı çəkir və ikinci
      // sorğu eyni məlumatın iki mənbəyini yaradardı.
      memory: listMemoryOps(db, task.id),
      // Sual və rəylər (Faza 5B). Ayrıca endpoint kimi YOX: task səhifəsi
      // onsuz da bu cavabı çəkir və ikinci sorğu eyni məlumatın iki mənbəyini
      // yaradardı (eyni mühakimə: `subtasks`, `memory`).
      questions: listQuestions(db, task.id).map(withOptions),
      reviews: listReviews(db, task.id),
      runs: listRunsForTask(db, task.id).map((r) => ({
        ...r,
        events: listEvents(db, r.id),
        verifications: listVerifications(db, r.id),
      })),
    }
  })

  /**
   * Diff-i əsas repoya TƏTBİQ edir (istifadəçinin "qəbul et" qərarı).
   *
   * NİYƏ AVTOMATİK DEYİL: paralel agentlər eyni faylı fərqli cür dəyişə bilər
   * və hansının qalacağını yalnız insan bilir. Avtomatik merge etsəydik, iki
   * taskın nəticəsi bir-birini səssizcə üstələyərdi — məhz izolyasiyanın
   * qarşısını almaq istədiyi hal.
   */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/diff/accept', async (req, reply) => {
    const artifact = getDiffArtifact(db, req.params.id)
    if (artifact === undefined) return reply.code(404).send({ error: 'Diff tapılmadı' })
    if (artifact.status !== 'pending') {
      return reply.code(409).send({ error: `Diff artıq həll olunub: ${artifact.status}` })
    }
    // Kəsilmiş diff YARIMÇIQDIR — `git apply` onu ya rədd edər, ya da (daha
    // pisi) yarısını tətbiq edərdi. Belə halda istifadəçi worktree-dən əl ilə
    // götürməlidir; yalan "qəbul edildi" cavabı vermirik.
    if (artifact.truncated) {
      return reply.code(409).send({
        error: 'Diff həddi aşdığı üçün kəsilib — tam dəyişikliyi worktree-dən götürün',
        worktreePath: artifact.worktreePath,
      })
    }
    // İkili fayl (issue #41): `git apply` `Binary files … differ` sətrini tətbiq
    // edə bilmir və patch-i BÜTÖV rədd edir — yəni bir PNG yanındakı on mətn
    // faylını da tətbiq olunmaz edir. Cəhd etmək ölçülmüş şəkildə zəmanətlə
    // uğursuzdur, ona görə burada dayanırıq: xam git xətası ("cannot apply
    // binary patch … without full index line") istifadəçiyə dəyişikliyin HƏLƏ DƏ
    // worktree qovluğunda olduğunu demir.
    const binaryFiles = detectBinaryFiles(artifact.content)
    if (binaryFiles.length > 0) {
      return reply.code(409).send({
        error:
          'Diff ikili (binary) fayl daşıyır — `git apply` belə patch-i tətbiq edə ' +
          'bilmir və patch-in MƏTN hissəsi də tətbiq olunmazdı. Faylları worktree ' +
          'qovluğundan əl ilə götürün.',
        binaryFiles,
        worktreePath: artifact.worktreePath,
      })
    }
    if (deps.worktrees === undefined) {
      return reply.code(503).send({ error: 'Worktree dəstəyi qurulmayıb' })
    }

    const applied = await deps.worktrees.apply({
      repo: artifact.repoPath,
      diff: artifact.content,
    })
    if (!applied.ok) {
      return reply.code(409).send({ error: applied.error ?? 'Diff tətbiq olunmadı' })
    }

    resolveArtifact(db, artifact.id, 'accepted')
    await deps.worktrees.remove({
      repo: artifact.repoPath,
      path: artifact.worktreePath,
      branch: artifact.branch,
    })
    return { ok: true, files: artifact.files }
  })

  /** Diff-i atır və worktree-ni silir. Əsas repoya heç nə yazılmır. */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/diff/reject', async (req, reply) => {
    const artifact = getDiffArtifact(db, req.params.id)
    if (artifact === undefined) return reply.code(404).send({ error: 'Diff tapılmadı' })
    if (artifact.status !== 'pending') {
      return reply.code(409).send({ error: `Diff artıq həll olunub: ${artifact.status}` })
    }
    if (deps.worktrees === undefined) {
      return reply.code(503).send({ error: 'Worktree dəstəyi qurulmayıb' })
    }

    // Sətir SİLİNMİR, `rejected` işarələnir: "bu task nə etmişdi?" sualının
    // cavabı diff mətnindədir və o, qərardan sonra da lazım ola bilər.
    resolveArtifact(db, artifact.id, 'rejected')
    await deps.worktrees.remove({
      repo: artifact.repoPath,
      path: artifact.worktreePath,
      branch: artifact.branch,
    })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req, reply) => {
    const task = getTask(db, req.params.id)
    if (task === undefined) return reply.code(404).send({ error: 'Task tapılmadı' })

    const cancelled = listRunsForTask(db, task.id)
      .filter((r) => r.status === 'running')
      .filter((r) => supervisor.cancel(r.id))
      .map((r) => r.id)

    // Gözləyən suallar da bağlanır (Faza 5B): task dayandırılırsa cavab heç
    // yerə çatmayacaq və UI əbədi "cavab gözləyir" göstərərdi.
    for (const q of listQuestions(db, task.id)) {
      if (q.status === 'pending') deps.questions?.cancel(q.id)
    }

    return { cancelled }
  })

  app.get('/api/questions/pending', async () => ({
    questions: listPendingQuestions(db).map(withOptions),
  }))

  app.post<{ Params: { id: string; qid: string } }>(
    '/api/tasks/:id/questions/:qid/answer',
    async (req, reply) => {
      const parsed = AnswerQuestionBody.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

      const question = getQuestion(db, req.params.qid)
      if (question === undefined || question.taskId !== req.params.id) {
        return reply.code(404).send({ error: 'Sual tapılmadı' })
      }
      if (question.status !== 'pending') {
        // 409, 400 YOX: cavab GECİKDİ — istifadəçi səhv etməyib, sual artıq
        // bağlanıb. 400 yazsaydıq o, öz göndərişini səhv sayardı.
        return reply.code(409).send({ error: 'Sual artıq bağlanıb' })
      }

      const answer = parsed.data.answer
      // Forma yoxlaması BURADADIR, zod sxemində yox: `kind` yalnız serverdə,
      // DB sətrində bilinir.
      const problem = answerProblem(
        question.kind,
        JSON.parse(question.optionsJson) as string[],
        answer,
      )
      if (problem !== null) return reply.code(400).send({ error: problem })

      answerQuestion(db, question.id, answer)
      // `delivered: false` = gözləyən proses YOXDUR (server yenidən
      // başladılıb). Cavab DB-yə yazılır, amma icra davam etməyəcək —
      // istifadəçi bunu bilməlidir, yoxsa boş yerə gözləyərdi.
      const delivered = deps.questions?.resolve(question.id, answer) ?? false
      return { ok: true, delivered }
    },
  )

  app.post<{ Params: { id: string } }>('/api/tasks/:id/review', async (req, reply) => {
    const parsed = CreateReviewBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues })

    const task = getTask(db, req.params.id)
    if (task === undefined) return reply.code(404).send({ error: 'Task tapılmadı' })
    const ctx = getContext(db, task.contextId)
    if (ctx === undefined) return reply.code(404).send({ error: 'Kontekst tapılmadı' })

    const runs = listRunsForTask(db, task.id)
    const active = runs.filter((r) => r.status === 'running')

    createReview(db, {
      taskId: task.id,
      runId: active[0]?.id ?? null,
      text: parsed.data.text,
      mode: parsed.data.mode,
    })

    // Review KEŞ SƏTRİNİ LƏĞV EDİR: istifadəçi rəy yazırsa cavab səhv idi,
    // amma o cavab Pillə 0 keşinə ARTIQ düşüb və eyni prompt bir daha
    // göndəriləndə qaytarılardı. Açar `runs.cache_key`-dədir — burada YENİDƏN
    // HESABLANMIR, çünki o, model, runner, şablon və yaddaş digest-indən
    // asılıdır və hesablamanı iki yerdə təkrarlamaq səssiz uyğunsuzluq
    // mənbəyidir.
    for (const run of runs) {
      if (run.cacheKey !== null) deleteCacheEntry(db, run.cacheKey)
    }

    if (active.length > 0) {
      if (parsed.data.mode === 'interrupt') {
        // Proses ağacı öldürülür (qayda 6). Yarımçıq işin çıxış tokenləri
        // ödənilib atılır — bu, istifadəçinin AÇIQ seçimidir.
        for (const r of active) supervisor.cancel(r.id)
      }
      return { ok: true, applied: 'queued' }
    }

    // İcra işləmir — "növbəti icra" yoxdur, ona görə route YENİSİNİ başladır.
    // Sərhəd BURADADIR, nərdivanda yox: nərdivanın içində "rəy varsa bir daha
    // qaç" dövrəsi qursaydıq, ard-arda yazılan rəylər bir çağırışı sonsuz uzada
    // bilər və büdcə hesabı (`RemainingBudget`) mənasını itirərdi.
    const resumeSessionId = [...runs].reverse().find((r) => r.sessionId !== null)?.sessionId
    const restartCustomizations = await resolveContextCustomizations(
      db,
      ctx.id,
      ctx.builtinSkillsEnabled,
      deps.credentials,
    )
    const restart = (): Promise<unknown> =>
      ladder.run({
        task: { id: task.id, prompt: task.prompt },
        context: toLadderContext(
          ctx,
          restartCustomizations,
        ),
        ...(resumeSessionId != null ? { resumeSessionId } : {}),
      })

    const queued =
      deps.pool === undefined
        ? restart()
        : deps.pool.run(ctx.id, resolveMaxParallel(ctx.maxParallel), restart)
    void queued.catch((err: unknown) => {
      app.log.error({ err }, 'review yenidən başlatması tutulmamış xəta')
    })

    return { ok: true, applied: 'restarted' }
  })
}

/** `options_json` sətrini massivə açır — UI xam JSON oxumamalıdır. */
function withOptions(q: Question): Question & { options: string[] } {
  return { ...q, options: JSON.parse(q.optionsJson) as string[] }
}
