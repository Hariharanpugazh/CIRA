/**
 * CIRA side panel: a context workspace.
 *
 *   Read chat → 1. Select messages → 2. Review extracted context → 3. Save and/or send
 *
 * Nothing is saved or sent until the user confirms on the Send step. State
 * lives in ./state/workspace.ts (pure reducer) and ./hooks/useWorkspace.ts
 * (Chrome wiring).
 */
import { useMemo, type ReactNode } from 'react';
import { getSemanticExtension, scanDocument } from '@cira/core';
import { describeSync } from '@/shared/context-client';
import { applyItemSelection, buildPcoHandoff, estimateTokens } from '@/shared/context-selection';
import { isOllamaCorsError, MODE_LABEL } from '@/shared/extraction-settings';
import { ExtractionModeHint, ExtractionModeSelect, ProviderForm, type ExtractionModeControlProps } from './components/ExtractionModeControl';
import { brandFor, relayTargets } from './brands';
import { ActiveContextCard } from './components/ActiveContextCard';
import { ContextReview } from './components/ContextReview';
import { ContextSummary } from './components/ContextSummary';
import { ConversationHeader } from './components/ConversationHeader';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { ChevronLeftIcon, RefreshIcon, SaveIcon, SendIcon } from './components/icons';
import { LoadingState } from './components/LoadingState';
import { MessageSelector } from './components/MessageSelector';
import { OllamaSetupGuide } from './components/OllamaSetupGuide';
import { StatusBanner } from './components/StatusBanner';
import { StepIndicator } from './components/StepIndicator';
import { TargetSelector } from './components/TargetSelector';
import { useWorkspace } from './hooks/useWorkspace';
import { selectedItemIds } from './state/workspace';

export function SidePanel() {
  const { state, dispatch, tab, hasApiKey, readChat, reloadTab, continueToReview, submit, retrySync, clearActive, editActive, setMode, setProvider, setApiKey, fetchModels } =
    useWorkspace();
  const { step, conversation, busy } = state;
  const semantic = useMemo(() => (state.draft ? getSemanticExtension(state.draft) : undefined), [state.draft]);
  const source = conversation?.source ?? tab.source;
  const keptIds = useMemo(() => selectedItemIds(state), [state.draft, state.removedItems]);

  // Final context preview for the summary (only the kept items).
  const final = useMemo(() => {
    if (!state.draft) return null;
    const keep = new Set(keptIds);
    // Semantic drafts: exactly what will be saved/sent (annotations pruned with their items).
    const doc = getSemanticExtension(state.draft)
      ? applyItemSelection(state.draft, keptIds)
      : { ...state.draft, items: state.draft.items.filter((i) => keep.has(i.id)) };
    const text = buildPcoHandoff(doc, { source: conversation?.source ?? 'unknown', title: conversation?.title });
    const scan = scanDocument(doc);
    return { doc, tokens: estimateTokens(text), warnings: scan.hasFindings ? scan.warnings : [] };
  }, [state.draft, keptIds, conversation]);

  const targets = useMemo(() => relayTargets(source), [source]);
  const canRead = tab.tabId !== null && tab.source !== 'unknown' && busy?.kind !== 'reading';

  const menu = [
    { label: conversation ? 'Read chat again' : 'Read chat', onSelect: () => void readChat(), disabled: !canRead },
    { label: 'Reload tab', onSelect: () => void reloadTab(), disabled: tab.tabId === null },
    ...(conversation ? [{ label: 'Start over', onSelect: () => dispatch({ type: 'reset' }) }] : []),
  ];

  return (
    <div className="cp-app">
      <Header source={tab.source} actions={menu} />

      {conversation && <ConversationHeader title={conversation.title} source={conversation.source} messageCount={conversation.messages.length} step={step} />}

      {state.active && step !== 'success' && (
        <ActiveContextCard active={state.active} busy={!!busy} onEdit={editActive} onReplace={() => void readChat()} onClear={() => void clearActive()} />
      )}

      {step !== 'idle' && <StepIndicator step={step} />}

      {state.error && (
        <StatusBanner level="error" title={state.error} onDismiss={() => dispatch({ type: 'error/dismiss' })} />
      )}

      {state.semanticError && isOllamaCorsError(state.semanticError.code, state.provider) && (
        <OllamaSetupGuide
          provider={state.provider}
          disabled={!!busy}
          onTest={async () => {
            const r = await fetchModels();
            return r.ok ? { ok: true } : { ok: false, error: r.error };
          }}
          onRetry={() => void continueToReview()}
          onSwitchDeterministic={() => void continueToReview('deterministic')}
          onDismiss={() => dispatch({ type: 'error/dismiss' })}
        />
      )}

      {state.semanticError && !isOllamaCorsError(state.semanticError.code, state.provider) && (
        <StatusBanner
          level="error"
          title="Semantic extraction unavailable."
          onDismiss={() => dispatch({ type: 'error/dismiss' })}
          action={
            <span className="cp-banner-buttons">
              <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={() => void continueToReview()} disabled={!!busy}>
                <RefreshIcon size={13} /> Retry
              </button>{' '}
              <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={() => void continueToReview('deterministic')} disabled={!!busy}>
                Switch to Deterministic
              </button>
            </span>
          }
        >
          {state.semanticError.message} Your message selection is unchanged.
        </StatusBanner>
      )}

      {step === 'review' && semantic?.fallback && (
        <StatusBanner
          level="warn"
          title="Semantic extraction unavailable: showing deterministic results only."
          action={
            <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={() => void continueToReview()} disabled={!!busy}>
              <RefreshIcon size={13} /> Retry semantic
            </button>
          }
        >
          {state.draftInfo?.fallbackReason ?? 'The semantic model could not be used.'}
        </StatusBanner>
      )}

      <main className="cp-main">
        {step === 'idle' &&
          (tab.source === 'unknown' ? (
            <EmptyState title="No conversation detected" body="Open a supported AI conversation (ChatGPT, Claude, Gemini, …) and reload the tab." />
          ) : (
            <EmptyState title={`Carry context from ${brandFor(tab.source).name}`} body="Read the conversation, choose the messages that matter, review what CIRA extracted, then save or send it.">
              <button type="button" className="cp-btn cp-btn--primary" onClick={() => void readChat()} disabled={!canRead}>
                {busy?.kind === 'reading' ? 'Reading conversation…' : 'Read chat'}
              </button>
            </EmptyState>
          ))}

        {step === 'select' && <MessageSelector messages={state.messages} selected={state.selectedMessages} query={state.query} dispatch={dispatch} />}

        {step === 'review' && state.draft && (
          <ContextReview draft={state.draft} removed={state.removedItems} dispatch={dispatch}>
            {semantic && !semantic.fallback && (
              <p className="cp-hint cp-extracted-by">
                {MODE_LABEL[semantic.mode]} extraction
                {state.draftInfo?.provider ? ` · ${state.draftInfo.provider.model} on ${state.draftInfo.provider.host} (${state.draftInfo.provider.locality})` : ''}. Model
                output can be wrong or incomplete: check each item before you continue.
              </p>
            )}
            {final && conversation && (
              <ContextSummary
                messages={state.selectedMessages.size}
                totalMessages={conversation.messages.length}
                items={final.doc.items.length}
                tokens={final.tokens}
                source={conversation.source}
                warnings={final.warnings}
              />
            )}
          </ContextReview>
        )}

        {step === 'send' && (
          <TargetSelector
            targets={targets}
            target={state.target}
            saveLocally={state.saveLocally}
            onTarget={(t) => dispatch({ type: 'target', target: t })}
            onSaveLocally={(v) => dispatch({ type: 'saveLocally', value: v })}
          />
        )}

        {step === 'success' && state.outcome && <SuccessView outcome={state.outcome} busy={busy?.kind === 'syncing'} onRetry={() => void retrySync()} />}
      </main>

      {busy && busy.kind !== 'reading' && <LoadingState label={busy.label} />}

      <Footer
        step={step}
        busy={!!busy}
        selectedMessages={state.selectedMessages.size}
        selectedItems={keptIds.length}
        target={state.target}
        saveLocally={state.saveLocally}
        onBack={() => dispatch({ type: 'back' })}
        onReview={() => void continueToReview()}
        modeControl={
          step === 'select'
            ? {
                mode: state.mode,
                provider: state.provider,
                providerOpen: state.providerOpen,
                hasApiKey,
                disabled: !!busy,
                onMode: setMode,
                onProvider: setProvider,
                onProviderOpen: (open) => dispatch({ type: 'provider/open', open }),
                onApiKey: (key) => void setApiKey(key),
                onFetchModels: fetchModels,
              }
            : undefined
        }
        onSend={() => dispatch({ type: 'send/open' })}
        onSubmit={() => void submit()}
        onNew={() => void readChat()}
        canRead={canRead}
      />
    </div>
  );
}

function SuccessView({ outcome, busy, onRetry }: { outcome: NonNullable<ReturnType<typeof useWorkspace>['state']['outcome']>; busy: boolean; onRetry: () => void }) {
  const sync = outcome.sync ? describeSync(outcome.sync) : null;
  return (
    <div className="cp-panel cp-success">
      <StatusBanner level={sync && !sync.ok ? 'warn' : 'success'} title="Context ready">
        <ul className="cp-facts">
          <li>{outcome.messageCount} message{outcome.messageCount === 1 ? '' : 's'} selected</li>
          <li>{outcome.itemCount} context item{outcome.itemCount === 1 ? '' : 's'}</li>
          <li>{outcome.saved ? (sync?.label ?? 'Saved in browser') : 'Not saved (send only)'}</li>
          {outcome.sentTo && <li>Sent to {brandFor(outcome.sentTo).name}: review the message there, then press Send.</li>}
        </ul>
      </StatusBanner>
      {sync && !sync.ok && (
        <StatusBanner
          level="warn"
          title="Local sync unavailable"
          action={sync.retry ? <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={onRetry} disabled={busy}><RefreshIcon size={13} /> {busy ? 'Retrying…' : 'Retry'}</button> : undefined}
        >
          {sync.detail}
        </StatusBanner>
      )}
      {outcome.safetyWarnings.length > 0 && (
        <StatusBanner level="warn" title="Potential secrets included">{outcome.safetyWarnings.join(' ')}</StatusBanner>
      )}
    </div>
  );
}

interface FooterProps {
  step: ReturnType<typeof useWorkspace>['state']['step'];
  busy: boolean;
  selectedMessages: number;
  selectedItems: number;
  target: string | null;
  saveLocally: boolean;
  canRead: boolean;
  onBack: () => void;
  onReview: () => void;
  onSend: () => void;
  onSubmit: () => void;
  onNew: () => void;
  /** Select step only. */
  modeControl?: ExtractionModeControlProps;
}

function Footer({ step, busy, selectedMessages, selectedItems, target, saveLocally, canRead, onBack, onReview, onSend, onSubmit, onNew, modeControl }: FooterProps) {
  if (step === 'idle') return null;
  const back = step === 'review' || step === 'send' ? (
    <button type="button" className="cp-btn cp-btn--ghost" onClick={onBack} disabled={busy}><ChevronLeftIcon size={14} /> Back</button>
  ) : null;

  let primary: ReactNode = null;
  if (step === 'select') {
    primary = <button type="button" className="cp-btn cp-btn--primary" onClick={onReview} disabled={busy || selectedMessages === 0}>Continue to Review</button>;
  } else if (step === 'review') {
    primary = <button type="button" className="cp-btn cp-btn--primary" onClick={onSend} disabled={busy || selectedItems === 0}>Continue</button>;
  } else if (step === 'send') {
    const name = target ? brandFor(target).name : '';
    const label = target ? (saveLocally ? `Save & send to ${name}` : `Send to ${name}`) : 'Save context';
    primary = (
      <button type="button" className="cp-btn cp-btn--primary" onClick={onSubmit} disabled={busy || (!target && !saveLocally)}>
        {target ? <SendIcon size={14} /> : <SaveIcon size={14} />} {label}
      </button>
    );
  } else if (step === 'success') {
    primary = <button type="button" className="cp-btn cp-btn--ghost" onClick={onNew} disabled={busy || !canRead}>Start a new context</button>;
  }

  const hint =
    step === 'select' && selectedMessages === 0 ? 'Select at least one message to continue.' :
    step === 'review' && selectedItems === 0 ? 'Select at least one context item.' :
    step === 'send' && !target && !saveLocally ? 'Choose a target AI or Save locally.' : null;

  return (
    <footer className="cp-footer">
      {modeControl && modeControl.mode !== 'deterministic' && modeControl.providerOpen && <ProviderForm {...modeControl} />}
      {modeControl && <ExtractionModeHint mode={modeControl.mode} provider={modeControl.provider} />}
      {hint && <div className="cp-footer-hint">{hint}</div>}
      <div className="cp-footer-row">
        {back}
        {modeControl && <ExtractionModeSelect {...modeControl} />}
        <span className="cp-spacer" />
        {primary}
      </div>
    </footer>
  );
}
