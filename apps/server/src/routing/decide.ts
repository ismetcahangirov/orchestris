import type { Runner } from "@orchestris/shared";
import type { Db } from "../db/client.js";
import { classifyTask, type TaskType } from "./classify.js";
import { runClassifier } from "./classifier.js";
import { findRoleModel, listWorkerCandidates } from "./candidates.js";
import { pickFallback, routeByRules, type RoutingDecision } from "./router.js";

export interface DecideContext {
  cwd: string | null;
  amplificationProfile: string;
  /** `models.id`. Qayda tutmadıqda seçilir. */
  defaultWorkerModelId: string | null;
}

export interface DecideInput {
  task: { id: string; prompt: string };
  context: DecideContext;
  /** İstifadəçinin açıq seçimi. Verilibsə routing İŞLƏMİR. */
  manual?: { runnerId: string; modelId: string };
  signal?: AbortSignal;
}

export type DecideOutcome =
  | {
      ok: true;
      decision: RoutingDecision;
      runner: Runner;
      /** Determinist təsnifatın nəticəsi — ledger bölgüsü üçün saxlanılır. */
      taskType: TaskType;
    }
  | { ok: false; error: string };

export interface WorkerRouterOptions {
  /** Runner hazırdırmı — çağıran `detect()` nəticəsini keşləyib ötürür. */
  isRunnerReady?: (runnerId: string) => boolean;
}

/**
 * Pillə 1 — işçi seçimi.
 *
 * ```
 * əl ilə seçim        → dərhal (0 token)
 * boss-only profili   → başçı (0 token) — baseline ölçmək üçün
 * qayda uyğun gəlir   → dərhal (0 token)          ⭐ hədəf hal
 * klassifikator əmin  → seç (~50 token)
 * qeyri-müəyyən       → kontekstin default işçisi / ən ucuz namizəd (0 token)
 * ```
 *
 * Başçının qərar verməsi (spesifikasiyadakı 3-cü addım) Faza 2-dədir; Faza 1
 * qeyri-müəyyənlikdə `default_worker_model_id`-yə düşür.
 *
 * KLASSİFİKATORUN XƏRCİ HƏMİŞƏ QƏRARA YAZILIR — qərar ondan gəlməsə də.
 * Çağırış onsuz da pul yandırıb; onu gizlətmək "qənaət" rəqəmini şişirdərdi.
 */
export class WorkerRouter {
  private readonly db: Db;
  private readonly runners: ReadonlyMap<string, Runner>;
  private readonly options: WorkerRouterOptions;

  constructor(
    db: Db,
    runners: ReadonlyMap<string, Runner>,
    options: WorkerRouterOptions = {},
  ) {
    this.db = db;
    this.runners = runners;
    this.options = options;
  }

  async decide(input: DecideInput): Promise<DecideOutcome> {
    // Təsnifat HƏR yolda hesablanır (0 token): əl ilə seçimdə də task tipi
    // ledger bölgüsü üçün lazımdır — `unknown` qalsaydı "mətn tasklarında
    // qənaət azdır" iddiasını yoxlamaq mümkün olmazdı.
    const features = classifyTask({
      prompt: input.task.prompt,
      ...(input.context.cwd !== null ? { cwd: input.context.cwd } : {}),
    });

    if (input.manual !== undefined)
      return this.manual(input.manual, features.taskType);

    const candidateInput = {
      db: this.db,
      runners: this.runners,
      ...(this.options.isRunnerReady !== undefined
        ? { isRunnerReady: this.options.isRunnerReady }
        : {}),
    };

    if (input.context.amplificationProfile === "boss-only") {
      return this.bossOnly(candidateInput, features.taskType);
    }

    const candidates = listWorkerCandidates(candidateInput);
    if (candidates.length === 0) {
      return {
        ok: false,
        error:
          'Auto rejimi üçün işçi modeli təyin olunmayıb — /providers səhifəsində ən azı bir modeli "işçi" kimi işarələ',
      };
    }

    const routeInput = {
      features,
      candidates,
      defaultWorkerRowId: input.context.defaultWorkerModelId,
    };

    const byRule = routeByRules(routeInput);
    if (byRule !== null) return this.resolve(byRule, features.taskType);

    // Qayda tutmadı → klassifikator (varsa). Bu, taskın ~50 tokenlik yeganə
    // orkestrasiya xərcidir və yalnız qeyri-müəyyən hallarda ödənilir.
    const spent = { tokens: 0, costUsd: undefined as number | undefined };
    const classifier = findRoleModel(candidateInput, "classifier");
    if (classifier !== undefined) {
      const runner = this.runners.get(classifier.runnerId);
      if (runner !== undefined) {
        const outcome = await runClassifier({
          runner,
          modelId: classifier.modelId,
          prompt: input.task.prompt,
          features,
          candidates,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        spent.tokens = outcome.tokens;
        spent.costUsd = outcome.costUsd;
        if (outcome.decision !== null)
          return this.resolve(outcome.decision, features.taskType);
      }
    }

    const fallback = pickFallback(routeInput);
    if (fallback === null) {
      return {
        ok: false,
        error:
          "Bu task üçün uyğun işçi tapılmadı (qabiliyyət və ya kontekst limiti çatmır)",
      };
    }

    // Klassifikator qərar vermədi, amma xərclədi — o xərc qərarın üstündə qalır.
    return this.resolve(
      {
        ...fallback,
        decisionTokens: spent.tokens,
        ...(spent.costUsd !== undefined
          ? { decisionCostUsd: spent.costUsd }
          : {}),
        reason:
          spent.tokens > 0
            ? `${fallback.reason} (klassifikator əmin olmadı, ${spent.tokens} token)`
            : fallback.reason,
      },
      features.taskType,
    );
  }

  private manual(
    manual: { runnerId: string; modelId: string },
    taskType: TaskType,
  ): DecideOutcome {
    const runner = this.runners.get(manual.runnerId);
    if (runner === undefined) {
      return {
        ok: false,
        error: `Runner mövcud deyil: ${manual.runnerId} (mövcudlar: ${[...this.runners.keys()].join(", ")})`,
      };
    }
    return {
      ok: true,
      runner,
      taskType,
      decision: {
        strategy: "manual",
        runnerId: manual.runnerId,
        modelId: manual.modelId,
        // Əl ilə seçimdə model cədvəldə olmaya bilər (CLI istənilən adı qəbul edir).
        chosenRowId: null,
        confidence: 1,
        reason: "istifadəçi əl ilə seçdi",
        decisionTokens: 0,
        decisionCostUsd: 0,
      },
    };
  }

  private bossOnly(
    candidateInput: {
      db: Db;
      runners: ReadonlyMap<string, Runner>;
      isRunnerReady?: (runnerId: string) => boolean;
    },
    taskType: TaskType,
  ): DecideOutcome {
    const boss = findRoleModel(candidateInput, "boss");
    if (boss === undefined) {
      return {
        ok: false,
        error:
          'boss-only profili üçün başçı modeli təyin olunmayıb — /providers səhifəsində bir modeli "başçı" seç',
      };
    }
    return this.resolve(
      {
        strategy: "boss",
        runnerId: boss.runnerId,
        modelId: boss.modelId,
        chosenRowId: boss.rowId,
        confidence: 1,
        reason:
          "boss-only profili: baseline ölçməsi üçün hər task başçıya gedir",
        decisionTokens: 0,
        decisionCostUsd: 0,
      },
      taskType,
    );
  }

  private resolve(
    decision: RoutingDecision,
    taskType: TaskType,
  ): DecideOutcome {
    const runner = this.runners.get(decision.runnerId);
    if (runner === undefined) {
      return { ok: false, error: `Runner mövcud deyil: ${decision.runnerId}` };
    }
    return { ok: true, decision, runner, taskType };
  }
}
