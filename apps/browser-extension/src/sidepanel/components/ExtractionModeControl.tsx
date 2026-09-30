/**
 * Compact extraction-mode picker for the Select step footer, plus a minimal
 * provider form that only appears for Semantic / Hybrid. Nothing here calls a
 * model; extraction only starts on "Continue to Review".
 */
import { useEffect, useId, useState } from 'react';
import {
  EXTRACTION_MODES,
  isLocalProvider,
  MODE_DESCRIPTION,
  MODE_LABEL,
  OLLAMA_BASE_URL,
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
}

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

export function ProviderForm({ provider, hasApiKey, disabled, onProvider, onApiKey }: Pick<ExtractionModeControlProps, 'provider' | 'hasApiKey' | 'disabled' | 'onProvider' | 'onApiKey'>) {
  const uid = useId();
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  useEffect(() => setUrl(provider.baseUrl), [provider.baseUrl]);
  useEffect(() => setModel(provider.model), [provider.model]);

  const commit = (next: Partial<ProviderSettings>) => onProvider({ ...provider, ...next });
  const onPreset = (preset: ProviderPreset) =>
    commit({ preset, baseUrl: preset === 'ollama' ? OLLAMA_BASE_URL : provider.preset === 'ollama' ? '' : provider.baseUrl });

  return (
    <div id="cp-provider" className="cp-provider" role="group" aria-label="Semantic model">
      <div className="cp-provider-row">
        <label htmlFor={`${uid}-preset`}>Provider</label>
        <select id={`${uid}-preset`} className="cp-select" value={provider.preset} disabled={disabled} onChange={(e) => onPreset(e.target.value as ProviderPreset)}>
          <option value="ollama">Ollama (local)</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
      </div>
      <div className="cp-provider-row">
        <label htmlFor={`${uid}-url`}>Endpoint</label>
        <input
          id={`${uid}-url`}
          className="cp-input"
          type="url"
          spellCheck={false}
          placeholder="https://api.example.com/v1"
          value={url}
          disabled={disabled}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url.trim() !== provider.baseUrl && commit({ baseUrl: url.trim() })}
        />
      </div>
      <div className="cp-provider-row">
        <label htmlFor={`${uid}-model`}>Model</label>
        <input
          id={`${uid}-model`}
          className="cp-input"
          type="text"
          spellCheck={false}
          placeholder={provider.preset === 'ollama' ? 'e.g. qwen2.5:7b (already pulled)' : 'model name'}
          value={model}
          disabled={disabled}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model.trim() !== provider.model && commit({ model: model.trim() })}
        />
      </div>
      {!isLocalProvider(provider) && (
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
                placeholder="optional"
                value={key}
                disabled={disabled}
                onChange={(e) => setKey(e.target.value)}
              />
              <button type="button" className="cp-btn cp-btn--ghost cp-btn--sm" onClick={() => { onApiKey(key); setKey(''); }} disabled={disabled || !key.trim()}>Save</button>
            </span>
          )}
        </div>
      )}
      <p className="cp-hint">
        {isLocalProvider(provider)
          ? 'CIRA never downloads a model. For Ollama, allow the extension with OLLAMA_ORIGINS=chrome-extension://*.'
          : 'The key is kept in session storage and is only used by the CIRA service worker.'}
      </p>
    </div>
  );
}
