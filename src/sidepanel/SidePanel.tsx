import { useState, useEffect, useCallback } from 'react';
import type { Conversation, Source } from '@/core/schema';
import type { RuntimeMessage, RelayStats } from '@/shared/messaging';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TARGET_URLS } from '@/shared/urls';
import { detectSource, timeAgo } from '@/shared/utils';
import { getAllPlatforms } from '@/core/platforms/registry';
import { PlatformAvatar } from '@/components/brand-icons';
import { Logo } from '@/components/Logo';

interface LiveContext {
  conversation: Conversation;
  summary: string;
}

interface PlatformBrand { name: string; initial: string; color: string }

const PLATFORM_BRAND: Record<string, PlatformBrand> = {
  chatgpt: { name: 'ChatGPT', initial: 'G', color: '#10a37f' },
  claude: { name: 'Claude', initial: 'C', color: '#d97757' },
  gemini: { name: 'Gemini', initial: 'G', color: '#4285f4' },
  deepseek: { name: 'DeepSeek', initial: 'D', color: '#4d6bfe' },
  perplexity: { name: 'Perplexity', initial: 'P', color: '#20808d' },
  copilot: { name: 'Copilot', initial: 'M', color: '#0a6cff' },
  grok: { name: 'Grok', initial: 'X', color: '#1d9bf0' },
  mistral: { name: 'Mistral', initial: 'M', color: '#fa520f' },
  qwen: { name: 'Qwen', initial: 'Q', color: '#615ced' },
  poe: { name: 'Poe', initial: 'P', color: '#5d3fd3' },
  kimi: { name: 'Kimi', initial: 'K', color: '#6c5ce7' },
  huggingchat: { name: 'HuggingChat', initial: 'H', color: '#ff9d00' },
  notebooklm: { name: 'NotebookLM', initial: 'N', color: '#1a73e8' },
  you: { name: 'You.com', initial: 'Y', color: '#7c3aed' },
  characterai: { name: 'Character.AI', initial: 'A', color: '#5b6ee1' },
  pi: { name: 'Pi', initial: '\u03C0', color: '#a78bfa' },
  zai: { name: 'Z.ai', initial: 'Z', color: '#2d9cdb' },
  unknown: { name: 'this chat', initial: '?', color: '#7d7d7d' },
};

function brandFor(source: string): PlatformBrand {
  return PLATFORM_BRAND[source] ?? PLATFORM_BRAND.unknown;
}

const FONT_STACK = "'Poppins', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

export function SidePanel() {
  const [source, setSource] = useState<string>('unknown');
  const [tabId, setTabId] = useState<number | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [liveCtx, setLiveCtx] = useState<LiveContext | null>(null);
  const [stats, setStats] = useState<RelayStats | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [banner, setBanner] = useState('');
  const [recentConvs, setRecentConvs] = useState<Array<{ id: string; title: string; source: string; at: string; msgs: number }>>([]);

  const updateTab = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) { setSource(detectSource(tab.url)); setTabId(tab.id ?? null); }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CIRA/GET_STATS' } as RuntimeMessage);
      if (res && typeof res === 'object' && 'totalRelays' in (res as object)) setStats(res as RelayStats);
    } catch {
      // Service worker may be sleeping; try again on next event.
    }
    try {
      const { ['cira.persist.conversations']: raw } = await chrome.storage.local.get('cira.persist.conversations');
      if (raw) {
        setRecentConvs(
          (raw as Array<{ id: string; conversation: Conversation; savedAt: string }>)
            .map((r) => ({ id: r.id, title: r.conversation.title, source: r.conversation.source, at: r.savedAt, msgs: r.conversation.messages.length }))
            .slice(0, 10),
        );
      }
    } catch {
      // Nothing saved yet.
    }
    try {
      const { ['cira.live.context']: ctx } = await chrome.storage.session.get('cira.live.context');
      if (ctx) setLiveCtx(ctx as LiveContext);
    } catch {
      // Session storage may be empty.
    }
  }, []);

  useEffect(() => {
    void updateTab(); void loadData();
    const onTab = () => { void updateTab(); void loadData(); };
    chrome.tabs.onActivated.addListener(onTab);
    chrome.tabs.onUpdated.addListener(onTab);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes['cira.persist.conversations'] || changes['cira.persist.stats'])) void loadData();
      if (area === 'session' && changes['cira.live.context']) {
        setLiveCtx(changes['cira.live.context'].newValue as LiveContext | undefined ?? null);
      }
    });
    return () => {
      chrome.tabs.onActivated.removeListener(onTab);
      chrome.tabs.onUpdated.removeListener(onTab);
    };
  }, [updateTab, loadData]);

  const capture = async () => {
    if (!tabId) return;
    setCapturing(true); setBanner('');
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'CIRA/EXTRACT_REQUEST' } as RuntimeMessage) as RuntimeMessage | undefined;
      if (reply && reply.type === 'CIRA/EXTRACT_RESPONSE') {
        setConv(reply.conversation);
        setBanner(`${reply.conversation.messages.length} messages captured`);
        chrome.storage.session.set({ [`cira.captured.tab.${tabId}`]: true });
        setCapturing(false);
        return;
      }
    } catch {
      // Content script may not be loaded yet; fall through to inject.
    }
    try {
      const manifest = chrome.runtime.getManifest();
      const jsFile = manifest.content_scripts?.[0]?.js?.[0];
      if (jsFile) {
        await chrome.scripting.executeScript({ target: { tabId }, files: [jsFile] });
        await new Promise((r) => setTimeout(r, 350));
        const retry = await chrome.tabs.sendMessage(tabId, { type: 'CIRA/EXTRACT_REQUEST' } as RuntimeMessage) as RuntimeMessage | undefined;
        if (retry && retry.type === 'CIRA/EXTRACT_RESPONSE') {
          setConv(retry.conversation);
          setBanner(`${retry.conversation.messages.length} messages captured`);
          chrome.storage.session.set({ [`cira.captured.tab.${tabId}`]: true });
          setCapturing(false);
          return;
        }
      }
    } catch {
      // Fall through to user-visible failure.
    }
    setBanner('Reload this tab to activate CIRA.');
    setCapturing(false);
  };

  const reloadAndCapture = async () => {
    if (!tabId) return;
    setBanner('Reloading...');
    await chrome.tabs.reload(tabId);
    await new Promise((r) => setTimeout(r, 2000));
    void capture();
  };

  const relay = async (target: Source) => {
    const payload = conv ?? liveCtx?.conversation;
    if (!payload) return;
    setSending(target);
    try {
      await chrome.runtime.sendMessage({
        type: 'CIRA/STAGE_RELAY',
        target,
        payload: { conversation: payload, summary: liveCtx?.summary ?? '' },
      } as RuntimeMessage);
      setBanner(`Opening ${brandFor(target).name}...`);
      window.open(TARGET_URLS[target] ?? `https://${target}.com`, '_blank');
      window.setTimeout(() => { void loadData(); setSending(null); }, 1500);
    } catch {
      setBanner('Relay failed');
      setSending(null);
    }
  };

  const allTargets = getAllPlatforms()
    .map((p) => p.id)
    .filter((id) => id !== source && PLATFORM_BRAND[id]) as Source[];

  const here = brandFor(source);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--background)', color: 'var(--foreground)', fontFamily: FONT_STACK }}>
      <header style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: '#fff' }}>
          <Logo size={20} />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0.01 }}>CIRA</div>
          <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>Carry your chat anywhere</div>
        </div>
        {source !== 'unknown' && (
          <Badge variant="secondary" style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 500, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <PlatformAvatar source={source} initial={here.initial} color={here.color} size={16} radius={5} />
            {here.name}
          </Badge>
        )}
      </header>

      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button variant="secondary" size="sm" onClick={capture} disabled={capturing || source === 'unknown'}>
          {capturing ? 'Reading...' : 'Read chat'}
        </Button>
        <Button variant="ghost" size="sm" onClick={reloadAndCapture} disabled={source === 'unknown'}>Reload tab</Button>
      </div>

      {banner && (
        <div style={{ padding: '8px 16px', fontSize: 12, background: 'var(--secondary)', color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {banner}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {(conv || liveCtx?.conversation) && (
          <Card style={{ marginBottom: 16 }}>
            <CardContent style={{ padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Active context</div>
              <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13, lineHeight: 1.35 }}>{(conv ?? liveCtx?.conversation)!.title}</div>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                {brandFor((conv ?? liveCtx?.conversation)!.source).name} · {(conv ?? liveCtx?.conversation)!.messages.length} messages
              </div>
            </CardContent>
          </Card>
        )}

        {(!conv && !liveCtx?.conversation) && (
          <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--muted-foreground)', fontSize: 12 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 18, background: 'var(--card)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: '#10a37f',
            }}>
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">
                <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8A2.5 2.5 0 0 1 17.5 17H10l-4 4v-4H6.5A2.5 2.5 0 0 1 4 14.5v-8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </div>
            {source === 'unknown'
              ? <p>Open any AI chat tab to begin.</p>
              : <p>Click <strong style={{ color: 'var(--foreground)' }}>Read chat</strong> to pull in the conversation, then send it anywhere.</p>}
          </div>
        )}

        {(conv || liveCtx?.conversation) && allTargets.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, padding: '0 4px' }}>
              Continue this chat in
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {allTargets.map((target) => {
                const b = brandFor(target);
                return (
                  <button
                    key={target}
                    onClick={() => relay(target)}
                    disabled={sending !== null}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px',
                      background: 'var(--card)', border: '1px solid var(--border)',
                      borderRadius: 11, color: 'var(--foreground)', cursor: sending ? 'default' : 'pointer',
                      fontFamily: FONT_STACK, fontSize: 12.5, fontWeight: 500, textAlign: 'left',
                      opacity: sending && sending !== target ? 0.55 : 1, transition: 'background 0.15s ease',
                    }}
                    onMouseOver={(e) => { if (!sending) (e.currentTarget as HTMLButtonElement).style.background = '#3a3a3a'; }}
                    onMouseOut={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--card)'; }}
                  >
                    <PlatformAvatar source={target} initial={b.initial} color={b.color} size={24} radius={7} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sending === target ? 'Opening…' : b.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {stats && stats.totalRelays > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
            {[
              { l: 'Carried over', v: stats.totalRelays },
              { l: 'Messages', v: stats.totalMessages },
              { l: 'Tokens saved', v: stats.estimatedTokensSaved?.toLocaleString() ?? '0' },
              { l: 'Rate limits', v: stats.rateLimitsDetected ?? 0 },
            ].map(({ l, v }) => (
              <Card key={l}>
                <CardContent style={{ padding: 10 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted-foreground)' }}>{l}</div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{v}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {recentConvs.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, padding: '0 4px' }}>Recent</div>
            {recentConvs.map((r) => {
              const b = brandFor(r.source);
              return (
                <Card key={r.id} style={{ marginBottom: 6, cursor: 'pointer' }} onClick={() => {
                  chrome.runtime.sendMessage({ type: 'CIRA/GET_CONVERSATION', id: r.id } as RuntimeMessage, (res: { conversation?: { conversation: Conversation } }) => {
                    if (res?.conversation?.conversation) setConv(res.conversation.conversation);
                  });
                }}>
                  <CardContent style={{ padding: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <PlatformAvatar source={r.source} initial={b.initial} color={b.color} size={26} radius={8} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted-foreground)', marginTop: 2 }}>
                        {b.name} · {r.msgs} messages · {timeAgo(r.at)}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
