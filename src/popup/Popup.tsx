import { useEffect, useState, useCallback, useMemo } from 'react';
import type { Conversation, Source } from '@/core/schema';
import type { RuntimeMessage, RelayStats } from '@/shared/messaging';
import { compress, countTokens } from '@/core/compress';
import { db, type ConversationRecord, type TemplateRecord } from '@/core/db';
import { scanForSecrets, generateWarnings } from '@/utils/secret-detector';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { TARGET_LABELS, TARGET_URLS, PLATFORM_BADGE } from '@/shared/urls';
import { detectSource, timeAgo, getAvailableTargets } from '@/shared/utils';

type Tab = 'relay' | 'search' | 'templates' | 'stats';

export function Popup() {
  const [tab, setTab] = useState<Tab>('relay');
  const [source, setSource] = useState<Source>('unknown');
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [relayLoading, setRelayLoading] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);

  const [recentRelays, setRecentRelays] = useState<ConversationRecord[]>([]);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [stats, setStats] = useState<RelayStats | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ConversationRecord[]>([]);
  const [searching, setSearching] = useState(false);

  const [secretWarnings, setSecretWarnings] = useState<string[]>([]);
  const [showExportMenu, setShowExportMenu] = useState(false);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      setTabId(tab?.id);
      setSource(detectSource(tab?.url));
    });
  }, []);

  useEffect(() => {
    if (!tabId) return;
    const sessionKey = `cira.captured.tab.${tabId}`;
    chrome.storage.session.get(sessionKey).then((result) => {
      if (!result[sessionKey]) {
        setStatusText('Click Capture to begin.');
        return;
      }
      setCapturing(true);
      setStatusText('Reading current chat...');
      setStatusLoading(true);
      setStatusError(false);

      chrome.tabs.sendMessage(tabId, { type: 'CIRA/EXTRACT_REQUEST' } satisfies RuntimeMessage)
        .then((reply: RuntimeMessage | undefined) => {
          if (reply && reply.type === 'CIRA/EXTRACT_RESPONSE') {
            processConversation(reply.conversation);
          } else {
            setStatusText('Click Capture to extract the conversation.');
            setStatusError(true);
          }
        })
        .catch(async () => {
          try {
            const manifest = chrome.runtime.getManifest();
            const jsFile = manifest.content_scripts?.[0]?.js?.[0];
            if (jsFile) {
              await chrome.scripting.executeScript({ target: { tabId }, files: [jsFile] });
              await new Promise((r) => setTimeout(r, 300));
              const retry = await chrome.tabs.sendMessage(tabId, { type: 'CIRA/EXTRACT_REQUEST' } satisfies RuntimeMessage) as RuntimeMessage | undefined;
              if (retry && retry.type === 'CIRA/EXTRACT_RESPONSE') {
                processConversation(retry.conversation);
                return;
              }
            }
          } catch {}
          setStatusText('Click Capture to begin.');
          setStatusError(true);
        })
        .finally(() => {
          setCapturing(false);
          setStatusLoading(false);
        });
    });
  }, [tabId]);

  function processConversation(convData: Conversation) {
    setConv(convData);
    setStatusText(`${convData.messages.length} messages captured.`);
    const allContent = convData.messages.map((m) => m.content).join('\n');
    const secrets = scanForSecrets(allContent);
    if (secrets.length > 0) setSecretWarnings(generateWarnings(secrets));
    db.conversations.add({
      source: convData.source, platform: convData.source,
      title: convData.title, url: convData.url,
      capturedAt: convData.capturedAt, messageCount: convData.messages.length,
      messages: convData.messages.map((m) => ({ role: m.role, content: m.content, codeBlocks: m.code })),
      tags: [], archived: false,
    }).catch(() => {});
    if (tabId) chrome.storage.session.set({ [`cira.captured.tab.${tabId}`]: true });
  }

  useEffect(() => {
    db.conversations.orderBy('capturedAt').reverse().limit(5).toArray()
      .then((rows) => setRecentRelays(rows)).catch(() => {});
  }, [conv]);

  useEffect(() => {
    if (tab === 'templates') {
      db.templates.orderBy('usageCount').reverse().toArray()
        .then((r) => setTemplates(r)).catch(() => {});
    }
  }, [tab]);

  useEffect(() => {
    if (tab === 'stats') {
      chrome.runtime.sendMessage({ type: 'CIRA/GET_STATS' } satisfies RuntimeMessage)
        .then((reply: unknown) => {
          if (reply && typeof reply === 'object' && 'totalRelays' in (reply as object)) {
            setStats(reply as RelayStats);
          }
        }).catch(() => {});
    }
  }, [tab]);

  const handleSearch = useCallback(async (q: string) => {
    setSearchQuery(q);
    if (q.trim().length < 1) { setSearchResults([]); return; }
    setSearching(true);
    const all = await db.conversations.orderBy('capturedAt').reverse().toArray();
    const lower = q.toLowerCase();
    setSearchResults(all.filter((c) => c.title.toLowerCase().includes(lower) || c.source.toLowerCase().includes(lower)).slice(0, 20));
    setSearching(false);
  }, []);

  const handleRelay = useCallback(async (target: Source) => {
    if (!conv) return;
    setRelayLoading(target);
    setStatusText(`Relaying to ${target}...`);
    setStatusLoading(true);
    const summary = compress(conv);
    await chrome.runtime.sendMessage({ type: 'CIRA/STAGE_RELAY', target, payload: { conversation: conv, summary } } satisfies RuntimeMessage);
    const dest = TARGET_URLS[target] || `https://${target}.com/`;
    await chrome.tabs.create({ url: dest });
    setRelayLoading(null);
    setStatusLoading(false);
    setStatusText(`Relayed to ${target}.`);
  }, [conv]);

  const handleScanSecrets = useCallback(() => {
    if (!conv) return;
    const secrets = scanForSecrets(conv.messages.map((m) => m.content).join('\n'));
    if (secrets.length > 0) { setSecretWarnings(generateWarnings(secrets)); setStatusText(`${secrets.length} potential secret(s) found.`); }
    else { setSecretWarnings([]); setStatusText('No secrets detected.'); }
  }, [conv]);

  const handleExport = useCallback((format: 'text' | 'json' | 'markdown') => {
    if (!conv) return;
    setShowExportMenu(false);
    let content = '';
    if (format === 'text') content = conv.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
    else if (format === 'json') content = JSON.stringify(conv, null, 2);
    else content = `# ${conv.title}\n\n${conv.messages.map((m) => `**${m.role}:** ${m.content}`).join('\n\n')}`;
    navigator.clipboard.writeText(content).then(() => setStatusText('Copied to clipboard.'));
  }, [conv]);

  const handleTemplateClick = useCallback((tmpl: TemplateRecord) => {
    const filled = tmpl.body.replace(/\{\{(\w+)\}\}/g, (_, name) => tmpl.variables.find((x) => x.name === name)?.defaultValue || `{{${name}}}`);
    navigator.clipboard.writeText(filled).then(() => setStatusText(`Template "${tmpl.name}" copied.`));
    db.templates.update(tmpl.id!, { usageCount: (tmpl.usageCount || 0) + 1 });
  }, []);

  const tokenEstimate = useMemo(() => conv ? conv.messages.reduce((sum, m) => sum + countTokens(m.content), 0) : 0, [conv]);
  const availableTargets = useMemo(() => getAvailableTargets(source), [source]);
  const maxSourceCount = useMemo(() => Math.max(1, ...(Object.values(stats?.relaysBySource ?? {}))), [stats]);

  return (
    <div className="popup-root">
      <div className="app-header">
        <span className="app-header-title">CIRA</span>
        <span className="app-header-sub">RELAY</span>
        {source !== 'unknown' && <Badge variant="secondary" style={{ marginLeft: 'auto', fontSize: 10 }}>{source}</Badge>}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <TabsList className="w-full justify-start rounded-none border-b" style={{ padding: '0 12px', height: 36, gap: 0 }}>
          <TabsTrigger value="relay" className="text-xs data-[state=active]:bg-accent">Relay</TabsTrigger>
          <TabsTrigger value="search" className="text-xs data-[state=active]:bg-accent">Search</TabsTrigger>
          <TabsTrigger value="templates" className="text-xs data-[state=active]:bg-accent">Templates</TabsTrigger>
          <TabsTrigger value="stats" className="text-xs data-[state=active]:bg-accent">Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="relay" className="flex-1 overflow-y-auto" style={{ maxHeight: 380 }}>
          <div className="platform-status">
            <div className="platform-status-icon">{PLATFORM_BADGE[source] || '?'}</div>
            <div style={{ flex: 1 }}>
              <div className="platform-status-name">{source === 'unknown' ? 'No AI platform detected' : source}</div>
              <div className="platform-status-meta">
                {capturing ? 'Scanning...' : conv ? `${conv.messages.length} messages · ~${tokenEstimate.toLocaleString()} tokens` : source !== 'unknown' ? 'Click Capture to extract' : 'Open an AI chat tab'}
              </div>
            </div>
          </div>

          {secretWarnings.length > 0 && (
            <div className="warning-banner">
              <strong>{secretWarnings[0]}</strong>
              {secretWarnings.length > 1 && (
                <div className="secret-list">{secretWarnings.slice(1).map((w, i) => <div key={i} className="secret-list-item">{w}</div>)}</div>
              )}
            </div>
          )}

          <div style={{ padding: '0 16px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {source !== 'unknown' && (
              <Button variant="secondary" disabled={capturing} onClick={() => {
                setCapturing(true); setStatusText('Reading...'); setStatusLoading(true);
                if (!tabId) return;
                chrome.tabs.sendMessage(tabId, { type: 'CIRA/EXTRACT_REQUEST' } satisfies RuntimeMessage)
                  .then((reply) => { if (reply && reply.type === 'CIRA/EXTRACT_RESPONSE') processConversation(reply.conversation); })
                  .catch(() => setStatusText('Refresh this tab to activate CIRA.'))
                  .finally(() => { setCapturing(false); setStatusLoading(false); });
              }} size="sm" className="w-full">
                {capturing ? 'Capturing...' : 'Capture Conversation'}
              </Button>
            )}

            {conv && availableTargets.map((target) => (
              <Button
                key={target}
                variant="outline"
                size="sm"
                disabled={relayLoading !== null}
                onClick={() => handleRelay(target)}
                className="w-full justify-start"
              >
                {relayLoading === target ? 'Relaying...' : TARGET_LABELS[target] || `Relay to ${target}`}
              </Button>
            ))}

            {source === 'unknown' && !capturing && (
              <div className="empty-state">
                <div className="empty-state-icon">\u26A1</div>
                <div className="empty-state-text">Open a conversation on ChatGPT, Claude, Gemini, or any other AI platform, then reopen this popup.</div>
              </div>
            )}
          </div>

          <div className="secondary-actions">
            <div style={{ position: 'relative' }}>
              <Button variant="ghost" size="sm" disabled={!conv} onClick={() => setShowExportMenu(!showExportMenu)}>Export</Button>
              {showExportMenu && (
                <div className="export-menu">
                  <button className="export-menu-item" onClick={() => handleExport('text')}>Plain Text</button>
                  <button className="export-menu-item" onClick={() => handleExport('json')}>JSON</button>
                  <button className="export-menu-item" onClick={() => handleExport('markdown')}>Markdown</button>
                </div>
              )}
            </div>
            <Button variant="ghost" size="sm" disabled={!conv} onClick={handleScanSecrets}>Scan Secrets</Button>
          </div>

          {recentRelays.length > 0 && (
            <>
              <div className="section-header">Recent</div>
              {recentRelays.map((r) => (
                <div key={r.id} className="recent-item" onClick={() => { if (r.url) chrome.tabs.create({ url: r.url }); }}>
                  <div className="recent-item-dot" />
                  <div className="recent-item-info">
                    <div className="recent-item-path">{r.source} · {r.title}</div>
                    <div className="recent-item-time">{timeAgo(r.capturedAt)}</div>
                  </div>
                </div>
              ))}
            </>
          )}

          {recentRelays.length === 0 && conv && (
            <>
              <div className="section-header">Recent</div>
              <div className="empty-state" style={{ padding: 16 }}>
                <div className="empty-state-text">No recent relays yet.</div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="search" className="flex-1 overflow-y-auto" style={{ maxHeight: 380 }}>
          <div style={{ padding: 12, position: 'relative' }}>
            <Input
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="h-8 text-xs"
            />
            <span className="search-kbd-hint">Ctrl+K</span>
          </div>
          <div style={{ padding: '0 12px' }}>
            {searching && <div className="loading-spinner"><div className="loading-spinner-dot" /><div className="loading-spinner-dot" /><div className="loading-spinner-dot" /></div>}
            {!searching && searchQuery.trim().length === 0 && (
              <div className="empty-state"><div className="empty-state-icon">⌘</div><div className="empty-state-text">Search across all your AI conversations.</div></div>
            )}
            {!searching && searchQuery.trim().length > 0 && searchResults.length === 0 && (
              <div className="empty-state"><div className="empty-state-text">No results for "{searchQuery}"</div></div>
            )}
            {!searching && searchResults.map((r) => (
              <button key={r.id} className="search-result-btn" onClick={() => { if (r.url) chrome.tabs.create({ url: r.url }); }}>
                <div style={{ fontWeight: 500 }}>{r.title}</div>
                <div style={{ fontSize: 10, color: 'var(--muted-foreground)', marginTop: 2 }}>{r.source} · {r.messageCount} messages · {timeAgo(r.capturedAt)}</div>
              </button>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="templates" className="flex-1 overflow-y-auto" style={{ maxHeight: 380 }}>
          <div className="templates-actions">
            <Button variant="outline" size="sm" className="w-full">+ New Template</Button>
          </div>
          {templates.length === 0 && (
            <div className="empty-state"><div className="empty-state-icon">{'\uD83D\uDCCB'}</div><div className="empty-state-text">No templates yet. Create reusable prompt templates.</div></div>
          )}
          {templates.map((tmpl) => (
            <div key={tmpl.id} className="template-card" onClick={() => handleTemplateClick(tmpl)}>
              <div className="template-card-name">{tmpl.name}</div>
              <div className="template-card-desc">{tmpl.description || 'No description'}</div>
              <div className="template-card-meta">{tmpl.variables.length} variables · Used {tmpl.usageCount || 0}x · {tmpl.category || 'General'}</div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="stats" className="flex-1 overflow-y-auto" style={{ maxHeight: 380, padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
            <Card>
              <CardContent style={{ padding: 12 }}>
                <div className="stat-card-value">{stats?.totalRelays ?? 0}</div>
                <div className="stat-card-label">Total Relays</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent style={{ padding: 12 }}>
                <div className="stat-card-value">{stats?.totalMessages?.toLocaleString() ?? '0'}</div>
                <div className="stat-card-label">Messages</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent style={{ padding: 12 }}>
                <div className="stat-card-value">{stats?.rateLimitsDetected ?? 0}</div>
                <div className="stat-card-label">Rate Limits</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent style={{ padding: 12 }}>
                <div className="stat-card-value">{stats?.lastRelayAt ? timeAgo(stats.lastRelayAt) : '--'}</div>
                <div className="stat-card-label">Last Relay</div>
              </CardContent>
            </Card>
          </div>

          <div className="bar-chart-section">
            <div className="bar-chart-header">Top Sources</div>
            {Object.entries(stats?.relaysBySource ?? {}).length === 0 && (
              <div style={{ padding: '12px 0', textAlign: 'center', color: 'var(--muted-foreground)', fontSize: 11 }}>No data yet.</div>
            )}
            {Object.entries(stats?.relaysBySource ?? {}).sort(([, a], [, b]) => b - a).slice(0, 5).map(([name, count]) => (
              <div key={name} className="bar-chart-row">
                <div className="bar-chart-label">{name}</div>
                <div className="bar-chart-track"><div className="bar-chart-fill" style={{ width: `${(count / maxSourceCount) * 100}%` }} /></div>
                <div className="bar-chart-count">{count}</div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <div className={`status-footer ${statusError ? 'status-footer--error' : ''} ${statusLoading ? 'status-footer--loading' : ''}`}>
        <span className="status-footer-prefix">›</span>
        <span className="status-footer-text">{statusText || 'Ready.'}</span>
        {statusLoading && <span className="status-footer-cursor visible">_</span>}
      </div>
    </div>
  );
}
