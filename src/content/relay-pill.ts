import { extractConversation } from '@/core/extractors/universal';
import { getPlatformId, getAllPlatforms } from '@/core/platforms/registry';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Source } from '@/core/schema';
import { TARGET_URLS } from '@/shared/urls';
import { getBrandIcon } from '@/shared/brand-icons-data';
import logoRaw from '@/assets/logo.svg?raw';

const LOGO_SVG = logoRaw.replace(/width="\d+(?:\.\d+)?" height="\d+(?:\.\d+)?"/, 'width="22" height="22"');

const STORAGE_KEY_POS = 'cira.pill.position';
const PILL_SIZE = 40;
const PILL_EXPANDED = 196;
const EDGE_GAP = 22;

interface SavedPosition {
  x: number;
  y: number;
}

const PILL_TEMPLATE = document.createElement('template');
PILL_TEMPLATE.innerHTML = `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
  :host {
    all: initial;
    position: fixed;
    z-index: 2147483646;
    font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; }
  .pill-wrap {
    position: relative;
    width: ${PILL_SIZE}px;
    height: ${PILL_SIZE}px;
    transition: width 0.28s cubic-bezier(0.34, 1.4, 0.64, 1);
  }
  .pill-wrap:hover,
  .pill-wrap.open { width: ${PILL_EXPANDED}px; }
  .pill-inner {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    height: 100%;
    padding: 4px;
    border-radius: 999px;
    background: #1d1d22;
    border: 1px solid rgba(255,255,255,0.10);
    cursor: grab;
    user-select: none;
    overflow: hidden;
    box-shadow: 0 6px 22px rgba(0,0,0,0.32);
    animation: enterSpring 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .pill-wrap.dragging .pill-inner {
    cursor: grabbing;
    box-shadow: 0 10px 28px rgba(0,0,0,0.45);
  }
  .pill-icon {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(21,112,239,0.25), 0 2px 8px rgba(21,112,239,0.30);
    transition: transform 0.2s ease;
  }
  .pill-icon svg { width: 22px; height: 22px; }
  .pill-wrap:hover .pill-icon { transform: scale(1.04); }
  .pill-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 16px;
    padding-left: 11px;
    font-size: 12.5px;
    font-weight: 600;
    color: #ececec;
    letter-spacing: 0.005em;
    opacity: 0;
    transform: translateX(-6px);
    transition: opacity 0.18s ease 0.06s, transform 0.2s ease 0.06s;
  }
  .pill-wrap:hover .pill-label,
  .pill-wrap.open .pill-label { opacity: 1; transform: translateX(0); }
  @keyframes enterSpring {
    0% { transform: scale(0.3); opacity: 0; }
    60% { transform: scale(1.08); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }

  /* Menu */
  .menu {
    position: absolute;
    bottom: ${PILL_SIZE + 10}px;
    right: 0;
    min-width: 240px;
    max-height: 70vh;
    overflow-y: auto;
    background: #2a2a2a;
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 14px;
    padding: 6px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.48);
    opacity: 0;
    transform: translateY(8px) scale(0.96);
    pointer-events: none;
    transition: opacity 0.18s cubic-bezier(0.34, 1.4, 0.64, 1),
                transform 0.18s cubic-bezier(0.34, 1.4, 0.64, 1);
    font-family: inherit;
  }
  .menu.left { right: auto; left: 0; }
  .menu.up { bottom: ${PILL_SIZE + 10}px; top: auto; }
  .menu.down { bottom: auto; top: ${PILL_SIZE + 10}px; }
  .menu.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
    pointer-events: auto;
  }
  .menu::-webkit-scrollbar { width: 6px; }
  .menu::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 3px; }
  .menu-header {
    padding: 10px 12px 6px;
    font-size: 13px;
    font-weight: 600;
    color: #ececec;
  }
  .menu-header-sub {
    padding: 0 12px 8px;
    font-size: 11px;
    color: #a8a8a8;
  }
  .menu-section {
    font-size: 10px;
    font-weight: 600;
    color: #7d7d7d;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    padding: 8px 12px 4px;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    font-size: 13px;
    color: #ececec;
    border-radius: 9px;
    cursor: pointer;
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    font-family: inherit;
    transition: background 0.12s ease;
  }
  .menu-item:hover { background: rgba(255,255,255,0.06); }
  .menu-item:disabled { opacity: 0.4; cursor: default; }
  .menu-ava {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    overflow: hidden;
  }
  .menu-ava svg { width: 16px; height: 16px; display: block; }
  .menu-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-divider {
    height: 1px;
    background: rgba(255,255,255,0.10);
    margin: 6px 8px;
  }
  .menu-action svg { width: 14px; height: 14px; flex-shrink: 0; color: #a8a8a8; }
</style>
<div class="pill-wrap" part="pill-wrap">
  <div class="pill-inner" part="pill-inner">
    <div class="pill-icon" part="pill-icon">
      ${LOGO_SVG}
    </div>
    <div class="pill-label" part="pill-label">Continue this chat</div>
  </div>
  <div class="menu" part="menu"></div>
</div>
`;

const ARROW_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 12h14m-5-5l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOWN_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

interface PlatformBrand {
  name: string;
  initial: string;
  color: string;
}

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
  unknown: { name: 'Unknown', initial: '?', color: '#7d7d7d' },
};

class CiraRelayPill extends HTMLElement {
  private _wrap: HTMLElement | null = null;
  private _label: HTMLElement | null = null;
  private _menu: HTMLElement | null = null;
  private _dragging = false;
  private _didDrag = false;
  private _dragStart = { x: 0, y: 0 };
  private _pos: SavedPosition;
  private _visible = true;
  private _menuOpen = false;
  private _busy: 'extract' | 'send' | null = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(PILL_TEMPLATE.content.cloneNode(true));
    this._pos = this._defaultPos();
  }

  async connectedCallback() {
    this._wrap = this.shadowRoot!.querySelector('.pill-wrap')!;
    this._label = this.shadowRoot!.querySelector('.pill-label')!;
    this._menu = this.shadowRoot!.querySelector('.menu')!;
    await this._loadPosition();
    this._positionPill();
    this._bindEvents();
    this._buildMenu();
  }

  private _defaultPos(): SavedPosition {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
    return { x: Math.max(0, vw - PILL_SIZE - EDGE_GAP), y: Math.max(0, vh - PILL_SIZE - EDGE_GAP) };
  }

  private async _loadPosition() {
    try {
      const domainKey = `${STORAGE_KEY_POS}.${location.hostname}`;
      const result = await chrome.storage.local.get(domainKey);
      const saved = result[domainKey] as SavedPosition | undefined;
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        this._pos = {
          x: Math.min(Math.max(0, saved.x), window.innerWidth - PILL_SIZE),
          y: Math.min(Math.max(0, saved.y), window.innerHeight - PILL_SIZE),
        };
      }
    } catch {
      // No saved position; keep default bottom-right.
    }
  }

  private async _savePosition() {
    try {
      const domainKey = `${STORAGE_KEY_POS}.${location.hostname}`;
      await chrome.storage.local.set({ [domainKey]: { x: this._pos.x, y: this._pos.y } });
    } catch {
      // ignore storage failures
    }
  }

  private _positionPill() {
    const style = this.style;
    style.left = 'auto';
    style.right = 'auto';
    style.top = 'auto';
    style.bottom = 'auto';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (this._pos.x + PILL_SIZE / 2 < vw / 2) {
      style.left = `${Math.max(0, this._pos.x)}px`;
    } else {
      style.right = `${Math.max(0, vw - this._pos.x - PILL_SIZE)}px`;
    }
    if (this._pos.y + PILL_SIZE / 2 < vh / 2) {
      style.top = `${Math.max(0, this._pos.y)}px`;
    } else {
      style.bottom = `${Math.max(0, vh - this._pos.y - PILL_SIZE)}px`;
    }
    this._positionMenu();
  }

  private _positionMenu() {
    if (!this._menu) return;
    const isLeft = this._pos.x + PILL_SIZE / 2 < window.innerWidth / 2;
    const isTop = this._pos.y + PILL_SIZE / 2 < window.innerHeight / 2;
    this._menu.classList.toggle('left', isLeft);
    this._menu.classList.toggle('down', isTop);
    this._menu.classList.toggle('up', !isTop);
  }

  private _bindEvents() {
    if (!this._wrap || !this._menu) return;
    const inner = this._wrap.querySelector('.pill-inner') as HTMLElement;

    inner.addEventListener('pointerdown', (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.button === 2) {
        e.preventDefault();
        this._toggleVisibility();
        return;
      }
      if ((pe.target as HTMLElement).closest('.menu-item')) return;
      if (pe.button !== 0) return;
      this._onDragStart(pe);
    });

    this._wrap.addEventListener('click', (e: Event) => {
      if (this._didDrag) {
        this._didDrag = false;
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest('.menu-item')) return;
      this._menuOpen ? this._closeMenu() : this._openMenu();
    });

    this._wrap.addEventListener('contextmenu', (e: Event) => {
      e.preventDefault();
      this._toggleVisibility();
    });

    document.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this._dragging) return;
      this._onDragMove(e);
    });

    document.addEventListener('pointerup', () => {
      if (!this._dragging) return;
      this._onDragEnd();
    });

    document.addEventListener('click', (e: Event) => {
      if (!this._menuOpen) return;
      const path = e.composedPath();
      if (path.includes(this)) return;
      this._closeMenu();
    });

    window.addEventListener('resize', () => this._positionPill());
  }

  private _onDragStart(e: PointerEvent) {
    this._dragging = true;
    this._didDrag = false;
    this._dragStart = { x: e.clientX - this._pos.x, y: e.clientY - this._pos.y };
    this._wrap!.classList.add('dragging');
    try {
      (this._wrap!.querySelector('.pill-inner') as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // pointer capture is best-effort
    }
  }

  private _onDragMove(e: PointerEvent) {
    const nextX = e.clientX - this._dragStart.x;
    const nextY = e.clientY - this._dragStart.y;
    if (Math.abs(nextX - this._pos.x) > 2 || Math.abs(nextY - this._pos.y) > 2) {
      this._didDrag = true;
    }
    this._pos.x = Math.max(0, Math.min(window.innerWidth - PILL_SIZE, nextX));
    this._pos.y = Math.max(0, Math.min(window.innerHeight - PILL_SIZE, nextY));
    this._positionPill();
  }

  private _onDragEnd() {
    this._dragging = false;
    this._wrap!.classList.remove('dragging');
    void this._savePosition();
  }

  private _toggleVisibility() {
    this._visible = !this._visible;
    if (this._wrap) {
      this._wrap.style.display = this._visible ? '' : 'none';
    }
  }

  private _buildMenu() {
    if (!this._menu) return;
    const sourceId = getPlatformId();
    const here = PLATFORM_BRAND[sourceId] ?? PLATFORM_BRAND.unknown;

    const frag = document.createDocumentFragment();

    const header = document.createElement('div');
    header.className = 'menu-header';
    header.textContent = 'Continue this chat in';
    frag.appendChild(header);

    const sub = document.createElement('div');
    sub.className = 'menu-header-sub';
    sub.textContent = sourceId === 'unknown' ? 'Open an AI chat first' : `From ${here.name}`;
    frag.appendChild(sub);

    const targets = getAllPlatforms()
      .map((p) => p.id)
      .filter((id) => id !== sourceId && PLATFORM_BRAND[id]);

    for (const id of targets) {
      frag.appendChild(this._createTargetItem(id));
    }

    const divider = document.createElement('div');
    divider.className = 'menu-divider';
    frag.appendChild(divider);

    const downloadHeader = document.createElement('div');
    downloadHeader.className = 'menu-section';
    downloadHeader.textContent = 'Save a copy';
    frag.appendChild(downloadHeader);
    frag.appendChild(this._createDownloadItem('Markdown', 'md'));
    frag.appendChild(this._createDownloadItem('JSON', 'json'));

    this._menu.innerHTML = '';
    this._menu.appendChild(frag);
  }

  private _createTargetItem(id: string): HTMLButtonElement {
    const brand = PLATFORM_BRAND[id] ?? PLATFORM_BRAND.unknown;
    const icon = getBrandIcon(id);
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    const ava = icon
      ? `<span class="menu-ava" style="background:${icon.chipBg};color:${icon.fg};padding:4px">${icon.svg}</span>`
      : `<span class="menu-ava" style="background:${brand.color}">${brand.initial}</span>`;
    btn.innerHTML = `
      ${ava}
      <span class="menu-name">${brand.name}</span>
      <span class="menu-action">${ARROW_SVG}</span>
    `;
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      void this._handleRelay(id);
    });
    return btn;
  }

  private _createDownloadItem(label: string, format: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    btn.innerHTML = `
      <span class="menu-ava" style="background:#3a3a3a">${DOWN_SVG}</span>
      <span class="menu-name">${label}</span>
    `;
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      void this._handleDownload(format);
    });
    return btn;
  }

  private _setLabel(text: string, ms?: number) {
    if (!this._label) return;
    this._label.textContent = text;
    if (ms) {
      window.setTimeout(() => {
        if (this._label && this._busy === null) this._label.textContent = 'Continue this chat';
      }, ms);
    }
  }

  private async _handleRelay(target: string) {
    if (this._busy) return;
    this._busy = 'extract';
    this._closeMenu();
    this._setLabel('Reading…');
    try {
      const conversation = await extractConversation();
      if (conversation.messages.length === 0) {
        this._busy = null;
        this._setLabel('Nothing to carry', 2000);
        return;
      }
      this._busy = 'send';
      this._setLabel(`Opening ${PLATFORM_BRAND[target]?.name ?? target}…`);
      const msg: RuntimeMessage = {
        type: 'CIRA/STAGE_RELAY',
        target: target as Source,
        payload: { conversation, summary: '' },
      };
      await chrome.runtime.sendMessage(msg);
      window.open(TARGET_URLS[target] || 'https://chatgpt.com/', '_blank', 'noopener');
      this._busy = null;
      this._setLabel('Continue this chat');
    } catch (err) {
      console.error('[CIRA] relay failed', err);
      this._busy = null;
      this._setLabel('Failed', 2000);
    }
  }

  private async _handleDownload(format: string) {
    if (this._busy) return;
    this._busy = 'extract';
    this._closeMenu();
    this._setLabel('Reading…');
    try {
      const conversation = await extractConversation();
      const safeName = (conversation.title.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_') || 'conversation');
      let blob: Blob;
      let filename: string;
      if (format === 'json') {
        blob = new Blob([JSON.stringify(conversation, null, 2)], { type: 'application/json' });
        filename = `${safeName}.json`;
      } else {
        const md = conversation.messages.map((m) => `## ${m.role}\n\n${m.content}`).join('\n\n---\n\n');
        blob = new Blob([`# ${conversation.title}\n\n${md}`], { type: 'text/markdown' });
        filename = `${safeName}.md`;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      this._busy = null;
      this._setLabel(format === 'json' ? 'Saved as JSON' : 'Saved as Markdown', 2000);
    } catch (err) {
      console.error('[CIRA] download failed', err);
      this._busy = null;
      this._setLabel('Failed', 2000);
    }
  }

  private _openMenu() {
    if (!this._wrap || !this._menu) return;
    this._menuOpen = true;
    this._wrap.classList.add('open');
    this._menu.classList.add('visible');
  }

  private _closeMenu() {
    if (!this._wrap || !this._menu) return;
    this._menuOpen = false;
    this._wrap.classList.remove('open');
    this._menu.classList.remove('visible');
  }
}

if (!customElements.get('cira-relay-pill')) {
  customElements.define('cira-relay-pill', CiraRelayPill);
}

export function createRelayPill(): HTMLElement {
  let el = document.querySelector('cira-relay-pill') as HTMLElement | null;
  if (!el) {
    el = document.createElement('cira-relay-pill') as HTMLElement;
    document.body.appendChild(el);
  }
  return el;
}
