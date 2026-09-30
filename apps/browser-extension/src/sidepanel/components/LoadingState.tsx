/** Inline, non-blocking progress line (the rest of the panel stays usable). */
export function LoadingState({ label }: { label: string }) {
  return (
    <div className="cp-loading" role="status" aria-live="polite">
      <span className="cp-spinner" aria-hidden="true" />
      {label}
    </div>
  );
}
