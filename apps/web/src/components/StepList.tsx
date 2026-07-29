import type { StepCondition, WorkflowStep } from '@orchestris/shared'

/**
 * Zəncirin oxunaqlı görünüşü.
 *
 * NİYƏ JSON-un YANINDA: redaktor JSON-dur (sürətli və tam), amma JSON
 * budaqlanmanı GÖSTƏRMİR — "hansı addım nə vaxt işə düşür?" sualının cavabı
 * sahələrin arasında itir. Bu siyahı həmin cavabı bir baxışda verir və
 * istifadəçi zənciri işə salmazdan ƏVVƏL səhvini görür.
 */
function describeCondition(c: StepCondition): string {
  const target = c.from === 'previous' ? 'əvvəlki addım' : `«${c.from}»`
  const test =
    c.test === 'succeeded'
      ? 'uğurludursa'
      : c.test === 'failed'
        ? 'sınıbsa'
        : c.test === 'empty'
          ? 'çıxışı boşdursa'
          : `çıxışında «${c.value ?? ''}» varsa`
  return `${target} ${test}${c.negate === true ? ' (TƏRS)' : ''}`
}

export default function StepList({
  steps,
}: {
  steps: readonly WorkflowStep[]
}): React.JSX.Element {
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => (
        <li key={step.id} className="flex gap-3 text-xs">
          <span className="mt-0.5 shrink-0 font-mono text-ink-dim">{i + 1}.</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-ink">{step.id}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  step.kind === 'http' ? 'bg-warn/15 text-warn' : 'bg-white/5 text-ink-dim'
                }`}
              >
                {step.kind}
              </span>
              {step.when !== undefined && (
                <span className="text-ink-dim">yalnız {describeCondition(step.when)}</span>
              )}
              {step.continueOnError === true && (
                <span className="text-ink-dim">sınsa da davam edir</span>
              )}
              {step.kind === 'task' && step.repeat !== undefined && (
                <span className="text-ink-dim">
                  {step.repeat.max} cəhdə qədər, {describeCondition(step.repeat.until)} dayanır
                </span>
              )}
              {step.kind === 'task' && step.decompose === true && (
                <span className="text-ink-dim">alt-tasklara bölünür</span>
              )}
            </div>
            <p className="mt-0.5 break-words font-mono text-[11px] text-ink-dim">
              {step.kind === 'http'
                ? `${step.method} ${step.url}`
                : step.prompt.slice(0, 200)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}
