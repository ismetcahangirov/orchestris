import { WsClientMessage, type Runner } from '@orchestris/shared'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Db } from './db/client.js'
import { cancelOrphanQuestions } from './db/interaction-repo.js'
import { getRunTaskId, getTask, markOrphanedRunsInterrupted } from './db/repo.js'
import { Decomposer } from './exec/decomposer.js'
import { Ladder } from './exec/ladder.js'
import { TaskPool } from './exec/pool.js'
import { DbQuestionGate } from './exec/question-gate.js'
import { DbReviewQueue } from './exec/review-queue.js'
import { Scheduler, SCHEDULER_TICK_MS } from './exec/scheduler.js'
import { WorkflowEngine } from './exec/workflow-engine.js'
import { RunSupervisor } from './exec/supervisor.js'
import type { WorktreeManager } from './exec/worktree.js'
import { NullProvider, type MemoryProvider } from './memory/provider.js'
import { MemorySession } from './memory/session.js'
import type { Catalog } from './registry/models-dev.js'
import { registerContextRoutes } from './routes/contexts.js'
import { registerCustomizationRoutes } from './routes/customizations.js'
import { registerMemoryRoutes } from './routes/memory.js'
import {
  defaultCatalog,
  registerProviderRoutes,
  seedProviders,
} from './routes/providers.js'
import { registerFsRoutes } from './routes/fs.js'
import { registerRunRoutes } from './routes/runs.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerWorkflowRoutes } from './routes/workflows.js'
import { seedCliProviders } from './routing/candidates.js'
import { WorkerRouter } from './routing/decide.js'
import { RunnerReadiness } from './routing/readiness.js'
import { KeyringStore, type CredentialStore } from './secrets/keychain.js'
import { WsHub } from './ws/hub.js'

export interface BuildAppInput {
  db: Db
  /**
   * DƏYİŞDİRİLƏ BİLƏN — `POST /api/providers` yeni runner-i bura yazır
   * (issue #44). Bütün istehlakçılar (router, readiness, `/api/health`) EYNİ
   * istinadı görür, ona görə əlavə olunan provayder prosesi yenidən
   * başlatmadan işləyir.
   */
  runners: Map<string, Runner>
  logger?: boolean
  /**
   * Testlər `MemoryStore` ötürməlidir. Default `KeyringStore` istifadəçinin
   * REAL OS anbarına yazardı və başsız CI runner-ində sınardı.
   */
  credentials?: CredentialStore
  /** Verilməsə diskdəki keşdən / repodakı snapshot-dan yüklənir. */
  catalog?: Catalog
  /** Testlərdə model kəşfi və kataloq yeniləməsi şəbəkəyə çıxmasın. */
  fetchImpl?: typeof fetch
  catalogCacheFile?: string
  /**
   * Paralel kod taskları üçün git worktree izolyasiyası.
   *
   * Verilməsə izolyasiya söndürülür və tasklar birbaşa kontekstin `cwd`-sində
   * işləyir. Default QƏSDƏN yoxdur: testlərin əksəriyyəti `cwd` təyin etmir,
   * amma default `GitWorktrees` qoysaydıq, `cwd` verən hər test istifadəçinin
   * REAL `~/.orchestris/worktrees/` qovluğuna yazardı (eyni prinsip:
   * `KeyringStore` — CLAUDE.md qayda 13).
   */
  worktrees?: WorktreeManager
  /**
   * Yaddaş provayderi (Faza 3).
   *
   * Verilməsə `NullProvider` işlədilir və nərdivana HEÇ NƏ qoşulmur — yəni
   * davranış Faza 2 ilə eynidir. Default QƏSDƏN `ClaudeMemProvider` deyil:
   * o, xarici prosesə qoşulur və istifadəçinin açıq razılığı olmadan
   * taskların mətnini kənar anbara yazmaq olmaz.
   */
  memory?: MemoryProvider
  /**
   * Cədvəl üzrə icranın TAYMERİNİ qurur (Faza 4).
   *
   * Default `false` və bu, QƏSDƏNDİR: `buildApp` testlərin əsas giriş
   * nöqtəsidir və hər test fon taymeri açsaydı, testlər bir-birinin cədvəlini
   * qaçırar, `--experimental` xəbərdarlıqları ilə asılı qalar və ən pisi —
   * SƏSSİZCƏ model çağırışı edə bilərdi. Taymer yalnız `main.ts`-də açılır.
   *
   * Məntiqin özü taymerdən ASILI DEYİL: `Scheduler.tick(now)` saf funksiyaya
   * yaxındır və testlərdə saat irəli sürülərək çağırılır.
   */
  startScheduler?: boolean
}

export interface OrchestrisApp {
  app: FastifyInstance
  /** Cədvəl motoru — `main.ts` taymeri onun üzərində qurur. */
  scheduler: Scheduler
}

export function buildApp(input: BuildAppInput): FastifyInstance {
  return buildOrchestris(input).app
}

export function buildOrchestris(input: BuildAppInput): OrchestrisApp {
  const app = Fastify({ logger: input.logger ?? false })
  const { db, runners } = input
  const credentials = input.credentials ?? new KeyringStore()
  const catalog = input.catalog ?? defaultCatalog(input.catalogCacheFile)

  // Server çökdükdən sonra qalan yetim icraları təmizlə. Hadisə jurnalı itmir.
  const orphans = markOrphanedRunsInterrupted(db)
  if (orphans > 0) app.log.warn(`${orphans} yetim icra interrupted işarələndi`)
  // Gözləyən suallar da yetimdir: cavabı gözləyən PROSES yoxdur, yəni cavab
  // heç yerə çatmayacaq. Təmizləməsəydik UI əbədi "cavab gözləyir" göstərərdi.
  const orphanQuestions = cancelOrphanQuestions(db)
  if (orphanQuestions > 0) app.log.warn(`${orphanQuestions} yetim sual ləğv edildi`)

  const hub = new WsHub()
  const supervisor = new RunSupervisor(db)

  // Pillə 1 — Auto rejimi. Hazırlıq keşi `detect()`-i dəqiqədə bir dəfədən
  // çox çağırmır: CLI runner-lərində o, proses spawn edir.
  const readiness = new RunnerReadiness(runners)
  const router = new WorkerRouter(db, runners, {
    isRunnerReady: (id) => readiness.isReady(id),
  })
  // Yaddaş (Faza 3). Provayder verilməyibsə sessiya YARADILMIR: `NullProvider`
  // ilə də sessiya qursaydıq, hər task boş `recall` çağırışı edərdi — nəticəsi
  // eyni, xərci sıfır, amma kod yolu fərqli olardı və "yaddaşsız" hal heç vaxt
  // sınaqdan keçməzdi.
  const memoryProvider = input.memory ?? new NullProvider()
  const memory =
    input.memory === undefined ? undefined : new MemorySession(db, memoryProvider)
  // Kontekst başına paralellik. Limit hər task göndərişində oxunur, ona görə
  // istifadəçi ayarı dəyişəndə server yenidən başladılmır.
  //
  // Nərdivandan ƏVVƏL qurulur: sual qapısı (Faza 5B) gözləyərkən slotu
  // buraxmaq üçün hovuza ehtiyac duyur.
  const pool = new TaskPool()
  // İnsan-döngədə (Faza 5B). Sual hadisəsi HƏR İKİ kanala yayılır: qlobal —
  // `LiveBar` nişanı üçün, task kanalı — açıq `/tasks/:id` səhifəsi üçün.
  const questionGate = new DbQuestionGate({
    db,
    pool,
    broadcast: (e) => {
      const msg = {
        type: 'question' as const,
        kind: e.kind,
        taskId: e.taskId,
        questionId: e.questionId,
      }
      hub.broadcastGlobal(msg)
      hub.broadcast(e.taskId, msg)
    },
  })
  const ladder = new Ladder(db, supervisor, router, input.worktrees, memory, {
    questions: questionGate,
    reviews: new DbReviewQueue(db),
  })
  // Task dekompozisiyası (Faza 4) — nərdivanın ÜSTÜNDƏ oturur və yalnız
  // `POST /api/tasks` gövdəsində `decompose: true` verildikdə işə düşür.
  const decomposer = new Decomposer(db, supervisor, ladder, router, input.worktrees)
  // Workflow zəncirləri (Faza 4). Xarici HTTP addımları FAIL-CLOSED-dur: icazə
  // yalnız `ORCHESTRIS_WORKFLOW_HTTP_ALLOW` ilə verilir (`workflow-http.ts`).
  // `worktrees` ötürülür ki, zəncirin kod addımları da baxış qapısından keçsin
  // (issue #36) — diff sintetik valideyn taskın adına `pending` yazılır.
  const workflowEngine = new WorkflowEngine({
    db,
    ladder,
    decomposer,
    pool,
    ...(input.worktrees !== undefined ? { worktrees: input.worktrees } : {}),
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  })

  // runId → taskId çevirməsi keşlənir: hər hadisə üçün DB sorğusu artıqdır.
  const runToTask = new Map<string, string>()
  supervisor.onEvent((runId, stored) => {
    let taskId = runToTask.get(runId)
    if (taskId === undefined) {
      taskId = getRunTaskId(db, runId)
      if (taskId !== undefined) runToTask.set(runId, taskId)
    }
    if (taskId === undefined) return
    hub.broadcast(taskId, {
      type: 'event',
      taskId,
      runId,
      seq: stored.seq,
      at: stored.at,
      event: stored.event,
    })
  })

  // Canlı zolaq — YALNIZ həyat dövrü, delta YOX (bax `WsHub.broadcastGlobal`).
  supervisor.onActivity((msg) => {
    hub.broadcastGlobal({
      type: 'activity',
      kind: msg.kind,
      runId: msg.runId,
      ...(msg.run !== undefined ? { run: msg.run } : {}),
    })
  })

  app.get('/api/health', async () => ({ ok: true, runners: [...runners.keys()] }))

  // Provayder cədvəli kataloqdan doldurulur — istifadəçi açar əlavə etməzdən
  // əvvəl də `/providers` səhifəsində hansı provayderlərin dəstəkləndiyini görür.
  seedProviders(db, catalog)
  // CLI runner-ləri də cədvələ düşür ki, Auto rejimi onların modellərini
  // namizəd kimi görsün — "fayl işi → CLI" qaydası bundan asılıdır.
  seedCliProviders(db, runners, catalog)

  registerContextRoutes(app, db)
  registerCustomizationRoutes(app, { db, credentials })
  registerRunRoutes(app, db)
  // Qovluq seçicisi (Faza 5A). `db` LAZIM DEYİL — bu route-lar yalnız fayl
  // sistemini oxuyur və heç nə saxlamır.
  registerFsRoutes(app)
  registerStatsRoutes(app, db)
  registerMemoryRoutes(app, { provider: memoryProvider, active: memory !== undefined })
  registerWorkflowRoutes(app, { db, engine: workflowEngine })
  registerTaskRoutes(app, {
    db,
    supervisor,
    ladder,
    runners,
    readiness,
    pool,
    decomposer,
    questions: questionGate,
    // MCP sirlərinin oxunması üçün (Faza 5C) — eyni nüsxə, `/api/mcp-servers`
    // ilə paylaşılır ki, yazma və oxuma eyni anbara getsin.
    credentials,
    ...(input.worktrees !== undefined ? { worktrees: input.worktrees } : {}),
  })
  registerProviderRoutes(app, {
    db,
    runners,
    credentials,
    catalog,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.catalogCacheFile !== undefined
      ? { catalogCacheFile: input.catalogCacheFile }
      : {}),
  })

  void app.register(websocket)
  void app.register(async (scoped) => {
    scoped.get('/ws', { websocket: true }, (conn) => {
      const socket = { send: (data: string) => conn.send(data) }

      conn.on('message', (raw: Buffer) => {
        let msg: WsClientMessage
        try {
          msg = WsClientMessage.parse(JSON.parse(raw.toString('utf8')))
        } catch {
          socket.send(
            JSON.stringify({ type: 'error', message: 'Yanlış mesaj formatı' }),
          )
          return
        }

        // `switch` — `if/else` zənciri deyil: köhnə `else` budağı BÜTÜN
        // naməlum mesajları `cancel` sayırdı. Faza 5A iki yeni mesaj tipi
        // əlavə edir və o davranışla `subscribe_activity` icra ləğvi kimi
        // oxunardı.
        switch (msg.type) {
          case 'subscribe': {
            if (getTask(db, msg.taskId) === undefined) {
              socket.send(JSON.stringify({ type: 'error', message: 'Task tapılmadı' }))
              return
            }
            hub.subscribe(msg.taskId, socket)
            return
          }
          case 'unsubscribe':
            hub.unsubscribe(msg.taskId, socket)
            return
          case 'subscribe_activity':
            hub.subscribeGlobal(socket)
            return
          case 'unsubscribe_activity':
            hub.unsubscribeGlobal(socket)
            return
          case 'cancel':
            supervisor.cancel(msg.runId)
            return
        }
      })

      conn.on('close', () => hub.removeSocket(socket))
    })
  })

  const scheduler = new Scheduler(db, workflowEngine)
  // Taymer YALNIZ açıq şəkildə istənəndə qurulur (`main.ts`). Bax
  // `BuildAppInput.startScheduler` — default `false` olmasının səbəbi orada.
  const timer =
    input.startScheduler === true
      ? setInterval(() => {
          void scheduler.tick().catch((err: unknown) => {
            app.log.error({ err }, 'scheduler.tick tutulmamış xəta')
          })
        }, SCHEDULER_TICK_MS)
      : undefined
  // `unref` MƏCBURİDİR: taymer proses ömrünü uzatmamalıdır, yoxsa `SIGINT`-dən
  // sonra server bağlanmaz və istifadəçi onu `kill` etməli olardı.
  timer?.unref()

  app.addHook('onClose', async () => {
    supervisor.cancelAll()
    // Gözləyən sual `Promise`-ləri prosesi ASILI SAXLAYARDI və `SIGINT`-dən
    // sonra server bağlanmazdı — istifadəçi onu `kill` etməli olardı.
    questionGate.cancelAll()
    if (timer !== undefined) clearInterval(timer)
  })

  return { app, scheduler }
}
