/**
 * Guided, one-time fix for the most common local-model snag: Ollama returns
 * HTTP 403 to browser extensions until its OLLAMA_ORIGINS allow-lists the
 * extension origin. Instead of a wall of error text, this shows the exact
 * command for the user's OS with a Copy button and a "Test connection"
 * button that confirms the fix without leaving the panel.
 */
import { useState } from 'react';
import { detectOS, ollamaSetupStep, providerHost, type ProviderSettings } from '@/shared/extraction-settings';
import { CheckIcon, CopyIcon, RefreshIcon } from './icons';

type TestState = { status: 'idle' | 'testing' | 'ok' } | { status: 'fail'; message: string };

export interface OllamaSetupGuideProps {
  provider: ProviderSettings;
  disabled: boolean;
  /** Pings the provider; resolves ok when Ollama answers (CORS fixed). */
  onTest: () => Promise<{ ok: boolean; error?: string }>;
  /** Re-run semantic extraction once the connection works. */
  onRetry: () => void;
  /** Fall back to deterministic without any model. */
  onSwitchDeterministic: () => void;
  onDismiss: () => void;
}

export function OllamaSetupGuide({ provider, disabled, onTest, onRetry, onSwitchDeterministic, onDismiss }: OllamaSetupGuideProps) {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const [os, setOs] = useState(() => detectOS(ua));
  const [copied, setCopied] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const step = ollamaSetupStep(os);
  const host = providerHost(provider) || 'Ollama';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(step.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const runTest = async () => {
    setTest({ status: 'testing' });
    try {
      const r = await onTest();
      if (r.ok) setTest({ status: 'ok' });
      else setTest({ status: 'fail', message: r.error ?? 'Still blocked. Make sure you restarted Ollama.' });
    } catch (err) {
      setTest({ status: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="cp-banner cp-banner--error cp-ollama-setup" role="alert">
      <div className="cp-banner-body">
        <div className="cp-banner-title">Let {host} talk to CIRA</div>
        <div className="cp-banner-text">
          {host} blocks browser extensions until you allow it once. This stays local — nothing is sent to the cloud.
        </div>

        <div className="cp-os-tabs" role="tablist" aria-label="Operating system">
          {(['windows', 'mac', 'linux'] as const).map((o) => (
            <button
              key={o}
              type="button"
              role="tab"
              aria-selected={os === o}
              className={`cp-os-tab${os === o ? ' is-active' : ''}`}
              onClick={() => { setOs(o); setTest({ status: 'idle' }); }}
            >
              {ollamaSetupStep(o).osLabel}
            </button>
          ))}
        </div>

        <ol className="cp-setup-steps">
          <li>
            Run this command, then {step.restartHint.replace(/^Then /, '')}
            <div className="cp-cmd">
              <code className="cp-cmd-text">{step.command}</code>
              <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm cp-cmd-copy" onClick={() => void copy()} aria-label="Copy command">
                {copied ? <><CheckIcon size={13} /> Copied</> : <><CopyIcon size={13} /> Copy</>}
              </button>
            </div>
          </li>
          <li>Come back here and test the connection.</li>
        </ol>

        <div className="cp-setup-actions">
          <button type="button" className="cp-btn cp-btn--sm" onClick={() => void runTest()} disabled={disabled || test.status === 'testing'}>
            {test.status === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          {test.status === 'ok' ? (
            <button type="button" className="cp-btn cp-btn--primary cp-btn--sm" onClick={onRetry} disabled={disabled}>
              <RefreshIcon size={13} /> Connected — run extraction
            </button>
          ) : (
            <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={onSwitchDeterministic} disabled={disabled}>
              Skip, use Deterministic
            </button>
          )}
        </div>

        {test.status === 'ok' && (
          <div className="cp-setup-result cp-setup-result--ok"><CheckIcon size={13} /> {host} is reachable. You're all set.</div>
        )}
        {test.status === 'fail' && (
          <div className="cp-setup-result cp-setup-result--fail">
            {test.message} Make sure you fully restarted Ollama after running the command.
          </div>
        )}
      </div>
      <button type="button" className="cp-icon-btn cp-icon-btn--sm" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}
