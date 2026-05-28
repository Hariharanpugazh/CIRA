import { useEffect, useState } from 'react';
import type { Conversation, RelayPayload } from '@/core/schema';
import type { RuntimeMessage } from '@/shared/messaging';
import { compress } from '@/core/compress';

type Site = 'chatgpt' | 'claude' | 'other';

function detectSite(url: string | undefined): Site {
  if (!url) return 'other';
  if (/^https:\/\/(chat\.openai\.com|chatgpt\.com)\//.test(url)) return 'chatgpt';
  if (/^https:\/\/claude\.ai\//.test(url)) return 'claude';
  return 'other';
}

export function Popup() {
  const [site, setSite] = useState<Site>('other');
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      setTabId(tab?.id);
      setSite(detectSite(tab?.url));
    });
  }, []);

  async function snapshot() {
    if (!tabId) return;
    setBusy(true);
    setStatus('Reading current chat...');
    try {
      const reply = (await chrome.tabs.sendMessage(tabId, {
        type: 'CIRA/EXTRACT_REQUEST',
      } satisfies RuntimeMessage)) as RuntimeMessage | undefined;
      if (reply && reply.type === 'CIRA/EXTRACT_RESPONSE') {
        setConv(reply.conversation);
        setStatus(`${reply.conversation.messages.length} messages captured.`);
      } else {
        setStatus('No response from page. Open a chat and try again.');
      }
    } catch (err) {
      console.error(err);
      setStatus('Could not reach page. Reload it and retry.');
    } finally {
      setBusy(false);
    }
  }

  async function relay(target: 'claude' | 'chatgpt') {
    if (!conv) return;
    setBusy(true);
    setStatus('Staging relay...');
    const payload: RelayPayload = { conversation: conv, summary: compress(conv) };
    await chrome.runtime.sendMessage({
      type: 'CIRA/STAGE_RELAY',
      target,
      payload,
    } satisfies RuntimeMessage);
    const dest = target === 'claude' ? 'https://claude.ai/new' : 'https://chatgpt.com/';
    await chrome.tabs.create({ url: dest });
    setStatus('Opened target tab. Review the prefilled prompt before sending.');
    setBusy(false);
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'linear-gradient(135deg,#7c3aed,#06b6d4)',
          }}
        />
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>CIRA</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Context Intelligent Relay Assistant</div>
        </div>
      </div>

      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
        Active tab: <strong>{site}</strong>
      </div>

      {site === 'other' ? (
        <p style={{ fontSize: 12, lineHeight: 1.5 }}>
          Open a conversation in <strong>ChatGPT</strong> or <strong>Claude</strong>, then
          reopen this popup.
        </p>
      ) : (
        <>
          <button onClick={snapshot} disabled={busy} style={btn('primary')}>
            {busy ? 'Working...' : 'Capture this chat'}
          </button>

          {conv && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
                <strong>{conv.title}</strong>
                <br />
                {conv.messages.length} messages
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {site !== 'claude' && (
                  <button onClick={() => relay('claude')} disabled={busy} style={btn('accent')}>
                    → Send to Claude
                  </button>
                )}
                {site !== 'chatgpt' && (
                  <button
                    onClick={() => relay('chatgpt')}
                    disabled={busy}
                    style={btn('accent')}
                  >
                    → Send to ChatGPT
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {status && (
        <div
          style={{
            marginTop: 12,
            padding: 8,
            background: '#1c1c22',
            borderRadius: 8,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}

function btn(variant: 'primary' | 'accent'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '8px 12px',
    borderRadius: 8,
    border: 0,
    color: 'white',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    flex: 1,
  };
  if (variant === 'primary') return { ...base, background: '#2563eb' };
  return { ...base, background: '#7c3aed' };
}
