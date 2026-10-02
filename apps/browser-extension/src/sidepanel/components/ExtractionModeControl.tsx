/**
 * Compact extraction-mode picker for the Select step footer, plus a minimal
 * provider form that only appears for Semantic / Hybrid. Nothing here calls a
 * model; extraction only starts on "Continue to Review".
 */
import { useEffect, useId, useState } from 'react';
import {
  EXTRACTION_MODES,
  MODE_DESCRIPTION,
  MODE_LABEL,
  PROVIDER_PRESETS,
  privacyHint,
  type ExtractionMode,
  type ProviderPreset,
  type ProviderSettings,
} from '@/shared/extraction-settings';

export interface ExtractionModeControlProps {
  mode: ExtractionMode;
  provider: ProviderSettings;
  providerOpen: boolean;
  hasApiKey: boolean;
  disabled: boolean;
  onMode: (mode: ExtractionMode) => void;
  onProvider: (provider: ProviderSettings) => void;
  onProviderOpen: (open: boolean) => void;
  onApiKey: (key: string) => void;
  /** Ask the provider which models the key can access (live list). */
  onFetchModels: () => Promise<FetchModelsResult>;
}

export type FetchModelsResult = { ok: true; models: string[]; host: string } | { ok: false; code: string; error: string };

/** The select itself (left side of the footer row). */
export function ExtractionModeSelect({ mode, disabled, onMode, providerOpen, onProviderOpen }: Pick<ExtractionModeControlProps, 'mode' | 'disabled' | 'onMode' | 'providerOpen' | 'onProviderOpen'>) {
  return (
    <span className="cp-mode">
      <label className="cp-visually-hidden" htmlFor="cp-mode-select">Extraction mode</label>
      <select
        id="cp-mode-select"
        className="cp-select"
        value={mode}
        disabled={disabled}
        aria-describedby="cp-mode-hint"
        onChange={(e) => onMode(e.target.value as ExtractionMode)}
      >
        {EXTRACTION_MODES.map((m) => (
          <option key={m} value={m} title={MODE_DESCRIPTION[m]}>
            {MODE_LABEL[m]}
          </option>
        ))}
      </select>
      {mode !== 'deterministic' && (
        <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" aria-expanded={providerOpen} aria-controls="cp-provider" onClick={() => onProviderOpen(!providerOpen)} disabled={disabled}>
          Model
        </button>
      )}
    </span>
  );
}

/** Description + privacy line (above the footer row). */
export function ExtractionModeHint({ mode, provider }: Pick<ExtractionModeControlProps, 'mode' | 'provider'>) {
  return (
    <div id="cp-mode-hint" className="cp-mode-hint">
      {MODE_DESCRIPTION[mode]} {privacyHint(mode, provider)}
    </div>
  );
}

export function ProviderForm({ provider, hasApiKey, disabled, onProvider, onApiKey, onFetchModels }: Pick<ExtractionModeControlProps, 'provider' | 'hasApiKey' | 'disabled' | 'onProvider' | 'onApiKey' | 'onFetchModels'>) {
  const uid = useId();
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  /** Live model list fetched from the provider (overrides the hardcoded suggestions). */
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const presetInfo = PROVIDER_PRESETS[provider.preset];
  const needsApiKey = presetInfo.requiresApiKey;

  useEffect(() => setUrl(provider.baseUrl), [provider.baseUrl]);
  useEffect(() => setModel(provider.model), [provider.model]);
  // A new provider or endpoint invalidates a previously fetched list.
  useEffect(() => { setFetched(null); setFetchError(null); }, [provider.preset, provider.baseUrl]);

  const commit = (next: Partial<ProviderSettings>) => onProvider({ ...provider, ...next });

  const onPreset = (preset: ProviderPreset) => {
    const info = PROVIDER_PRESETS[preset];
    commit({ preset, baseUrl: info.baseUrl, model: '' });
  };

  const runFetch = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const r = await onFetchModels();
      if (r.ok) {
        setFetched(r.models);
        // Keep the current model if it's in the list; otherwise don't guess.
        if (!r.models.includes(provider.model)) setModel('');
      } else {
        setFetchError(r.error);
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  // Prefer the live list; fall back to the preset's hardcoded suggestions.
  const options = fetched ?? presetInfo.modelSuggestions ?? null;
  const canFetch = !disabled && !fetching && (!needsApiKey || hasApiKey);

  return (
    <div id="cp-provider" className="cp-provider" role="group" aria-label="Semantic model">
      <div className="cp-provider-row">
        <label htmlFor={`${uid}-preset`}>Provider</label>
        <select id={`${uid}-preset`} className="cp-select" value={provider.preset} disabled={disabled} onChange={(e) => onPreset(e.target.value as ProviderPreset)}>
          {Object.entries(PROVIDER_PRESETS).map(([k, info]) => (
            <option key={k} value={k}>{info.label}</option>
          ))}
        </select>
      </div>

      {needsApiKey && (
        <div className="cp-provider-row">
          <label htmlFor={`${uid}-key`}>API key</label>
          {hasApiKey ? (
            <span className="cp-provider-key">
              <span className="cp-hint">Saved for this browser session</span>
              <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={() => onApiKey('')} disabled={disabled}>Clear</button>
            </span>
          ) : (
            <span className="cp-provider-key">
              <input
                id={`${uid}-key`}
                className="cp-input"
                type="password"
                autoComplete="off"
                placeholder="Enter your API key"
                value={key}
                disabled={disabled}
                onChange={(e) => setKey(e.target.value)}
              />
              <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={() => { onApiKey(key); setKey(''); }} disabled={disabled || !key.trim()}>Save</button>
            </span>
          )}
        </div>
      )}

      <div className="cp-provider-row">
        <label htmlFor={`${uid}-url`}>Endpoint</label>
        <input
          id={`${uid}-url`}
          className="cp-input"
          type="url"
          spellCheck={false}
          placeholder={presetInfo.baseUrl || 'https://api.example.com/v1'}
          value={url}
          disabled={disabled || (provider.preset !== 'custom' && !!presetInfo.baseUrl)}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url.trim() !== provider.baseUrl && commit({ baseUrl: url.trim() })}
        />
      </div>

      <div className="cp-provider-row">
        <label htmlFor={`${uid}-model`}>Model</label>
        {options && options.length > 0 ? (
          <select
            id={`${uid}-model`}
            className="cp-select"
            value={options.includes(model) ? model : model === '__custom__' ? '__custom__' : ''}
            disabled={disabled}
            onChange={(e) => { setModel(e.target.value); if (e.target.value !== '__custom__') commit({ model: e.target.value }); }}
          >
            <option value="">Select a model…</option>
            {options.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            <option value="__custom__">Custom model name…</option>
          </select>
        ) : (
          <input
            id={`${uid}-model`}
            className="cp-input"
            type="text"
            spellCheck={false}
            placeholder={presetInfo.modelPlaceholder}
            value={model}
            disabled={disabled}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model.trim() !== provider.model && commit({ model: model.trim() })}
          />
        )}
      </div>

      {model === '__custom__' && (
        <div className="cp-provider-row">
          <label htmlFor={`${uid}-custom-model`}>Custom model</label>
          <input
            id={`${uid}-custom-model`}
            className="cp-input"
            type="text"
            spellCheck={false}
            placeholder={presetInfo.modelPlaceholder}
            autoFocus
            disabled={disabled}
            onChange={(e) => setModel(e.target.value)}
            onBlur={(e) => { const v = e.target.value.trim(); if (v) commit({ model: v }); else setModel(provider.model); }}
          />
        </div>
      )}

      <div className="cp-provider-row cp-provider-row--actions">
        <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={() => void runFetch()} disabled={!canFetch}>
          {fetching ? 'Fetching models…' : fetched ? 'Refresh models' : 'Fetch available models'}
        </button>
        {fetched && <span className="cp-hint">{fetched.length} model{fetched.length === 1 ? '' : 's'} available for this key</span>}
        {!fetched && needsApiKey && !hasApiKey && <span className="cp-hint">Save an API key to list models.</span>}
      </div>

      {fetchError && <p className="cp-hint cp-hint--error" role="alert">{fetchError}</p>}

      {presetInfo.helpText && !fetchError && (
        <p className="cp-hint">{presetInfo.helpText}</p>
      )}
    </div>
  );
}
