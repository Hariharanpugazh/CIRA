import { useState, useEffect, useCallback } from 'react';
import type { Conversation, Source } from '@/core/schema';
import type { RuntimeMessage, RelayStats } from '@/shared/messaging';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TARGET_URLS } from '@/shared/urls';
import { detectSource, timeAgo } from '@/shared/utils';

interface LiveContext {
  conversation: Conversation;
  summary: string;
}

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
  const [portActive, setPortActive] = useState(false);

  const updateTab = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) { setSource(detectSource(tab.url)); setTabId(tab.id ?? null); }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CIRA/GET_STATS' } as RuntimeMessage);
      if (res && typeof res === 'object' && 'totalRelays' in (res as object)) setStats(res as RelayStats);
    } catch { }
    try {
      const { ['cira.persist.conversations']: raw } = await chrome.storage.local.get('cira.persist.conversations');
      if (raw) setRecentConvs((raw as Array<{ id: string; conversation: Conversation; savedAt: string }>).map(r => ({ id: r.id, title: r.conversation.title, source: r.conversation.source, at: r.savedAt, msgs: r.conversation.messages.length })).slice(0, 10));
    } catch { }
    try {
      const { ['cira.live.context']: ctx } = await chrome.storage.session.get('cira.live.context');
      if (ctx) setLiveCtx(ctx as LiveContext);
    } catch { }
  }, []);

  useEffect(() => {
    updateTab(); loadData();
    const h1 = () => { updateTab(); loadData(); };
    const h2 = () => { updateTab(); loadData(); };
    chrome.tabs.onActivated.addListener(h1);
    chrome.tabs.onUpdated.addListener(h2);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes['cira.persist.conversations'] || changes['cira.persist.stats'])) loadData();
      if (area === 'session' && changes['cira.live.context']) setLiveCtx(changes['cira.live.context'].newValue as LiveContext | undefined ?? null);
    });
    return () => { chrome.tabs.onActivated.removeListener(h1); chrome.tabs.onUpdated.removeListener(h2); };
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
        return;
      }
    } catch { }
    try {
      const manifest = chrome.runtime.getManifest();
      const jsFile = manifest.content_scripts?.[0]?.js?.[0];
      if (jsFile) {
        await chrome.scripting.executeScript({ target: { tabId }, files: [jsFile] });
        await new Promise((r) => setTimeout(r, 300));
        const retry = await chrome.tabs.sendMessage(tabId, { type: 'CIRA/EXTRACT_REQUEST' } as RuntimeMessage) as RuntimeMessage | undefined;
        if (retry && retry.type === 'CIRA/EXTRACT_RESPONSE') {
          setConv(retry.conversation);
          setBanner(`${retry.conversation.messages.length} messages captured`);
          chrome.storage.session.set({ [`cira.captured.tab.${tabId}`]: true });
          return;
        }
      }
    } catch { }
    setBanner('Reload this tab to activate CIRA.');
    setCapturing(false);
  };

  const reloadAndCapture = async () => {
    if (!tabId) return;
    setBanner('Reloading...');
    await chrome.tabs.reload(tabId);
    await new Promise((r) => setTimeout(r, 2000));
    capture();
  };

  const relay = async (target: Source) => {
    const payload = conv ?? liveCtx?.conversation;
    if (!payload) return;
    setSending(target);
    try {
      await chrome.runtime.sendMessage({ type: 'CIRA/STAGE_RELAY', target, payload: { conversation: payload, summary: liveCtx?.summary ?? '' } } as RuntimeMessage);
      setBanner(`Relayed to ${target}`);
      window.open(TARGET_URLS[target] ?? `https://${target}.com`, '_blank');
      setTimeout(() => { loadData(); setSending(null); }, 1500);
    } catch { setBanner('Relay failed'); setSending(null); }
  };

  const togglePort = () => {
    if (portActive) { setPortActive(false); setBanner('Live sync stopped'); return; }
    if (!tabId) return;
    setPortActive(true);
    setBanner('Live sync activated');
    try {
      const port = chrome.tabs.connect(tabId, { name: 'cira-sidepanel' });
      port.onMessage.addListener((msg: { type: string; conversation?: Conversation; summary?: string }) => {
        if (msg.type === 'LIVE_CONTEXT' && msg.conversation) { setLiveCtx({ conversation: msg.conversation, summary: msg.summary ?? '' }); setConv(msg.conversation); }
      });
      port.onDisconnect.addListener(() => setPortActive(false));
    } catch { setPortActive(false); setBanner('Could not connect'); }
  };

  const targets: Source[] = (['claude', 'chatgpt', 'gemini', 'deepseek', 'perplexity', 'copilot', 'grok', 'kimi', 'qwen', 'poe'] as Source[]).filter(t => t !== source);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--background)', color: 'var(--foreground)' }}>
      <header style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-sans)' }}>CIRA</span>
        <span style={{ fontSize: 10, color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}>RELAY HUB</span>
        {source !== 'unknown' && <Badge variant="secondary" style={{ marginLeft: 'auto', fontSize: 10 }}>{source}</Badge>}
      </header>

      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button variant="secondary" size="sm" onClick={capture} disabled={capturing || source === 'unknown'}>{capturing ? 'Capturing...' : 'Capture'}</Button>
        <Button variant="ghost" size="sm" onClick={reloadAndCapture} disabled={source === 'unknown'}>Reload Tab</Button>
        <Button variant={portActive ? 'destructive' : 'outline'} size="sm" onClick={togglePort}>{portActive ? 'Stop Sync' : 'Live Sync'}</Button>
      </div>

      {banner && (
        <div style={{ padding: '6px 16px', fontSize: 11, background: 'var(--secondary)', color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>› {banner}</div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {(conv || liveCtx?.conversation) && (
          <Card style={{ marginBottom: 16 }}>
            <CardContent style={{ padding: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Active Context</div>
              <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{(conv ?? liveCtx?.conversation)!.title}</div>
              <div style={{ fontSize: 10, color: 'var(--muted-foreground)', marginBottom: 10 }}>{(conv ?? liveCtx?.conversation)!.messages.length} messages · {(conv ?? liveCtx?.conversation)!.source}</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {targets.slice(0, 6).map(t => (
                  <Button key={t} variant="outline" size="sm" onClick={() => relay(t)} disabled={sending === t} style={{ fontSize: 10, padding: '3px 10px', height: 26 }}>{sending === t ? '...' : t}</Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {(!conv && !liveCtx?.conversation) && (
          <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--muted-foreground)', fontSize: 12 }}>
            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.25 }}>\u26A1</div>
            {source === 'unknown' ? <p>Open any AI chat tab to begin.</p> : <p>Click <strong style={{ color: 'var(--foreground)' }}>Capture</strong> to extract the conversation, then relay it anywhere.</p>}
          </div>
        )}

        {stats && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
            {[
              { l: 'Total Relays', v: stats.totalRelays },
              { l: 'Messages', v: stats.totalMessages },
              { l: 'Tokens Saved', v: stats.estimatedTokensSaved?.toLocaleString() ?? '0' },
              { l: 'Rate Limits', v: stats.rateLimitsDetected ?? 0 },
            ].map(({ l, v }) => (
              <Card key={l}>
                <CardContent style={{ padding: 10 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted-foreground)' }}>{l}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{v}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {recentConvs.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8, padding: '0 4px' }}>Recent</div>
            {recentConvs.map(r => (
              <Card key={r.id} style={{ marginBottom: 6, cursor: 'pointer' }} onClick={() => {
                chrome.runtime.sendMessage({ type: 'CIRA/GET_CONVERSATION', id: r.id } as RuntimeMessage, (res: { conversation?: { conversation: Conversation } }) => {
                  if (res?.conversation?.conversation) setConv(res.conversation.conversation);
                });
              }}>
                <CardContent style={{ padding: 10 }}>
                  <div style={{ fontWeight: 500, fontSize: 12 }}>{r.title}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted-foreground)', display: 'flex', gap: 8, marginTop: 2 }}>
                    <Badge variant="secondary" style={{ fontSize: 9 }}>{r.source}</Badge>
                    <span>{r.msgs} msgs</span>
                    <span style={{ marginLeft: 'auto' }}>{timeAgo(r.at)}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <footer style={{ padding: '6px 16px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
        › {portActive ? 'LIVE' : 'standby'} · {source}
      </footer>
    </div>
  );
}
