import { FLOW_STEPS, type Step } from '../state/workspace';

const LABELS: Record<(typeof FLOW_STEPS)[number], string> = { select: 'Select', review: 'Review', send: 'Send' };

export function StepIndicator({ step }: { step: Step }) {
  const current = step === 'success' ? FLOW_STEPS.length : FLOW_STEPS.indexOf(step as (typeof FLOW_STEPS)[number]);
  return (
    <ol className="cp-steps" aria-label="Progress">
      {FLOW_STEPS.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s} className={`cp-step cp-step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="cp-step-dot" aria-hidden="true" />
            {i + 1}. {LABELS[s]}
          </li>
        );
      })}
    </ol>
  );
}
