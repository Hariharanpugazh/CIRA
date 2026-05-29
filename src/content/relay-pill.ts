import { extractConversation } from '@/core/extractors/universal';
import { getPlatformId, getAllPlatforms } from '@/core/platforms/registry';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Source } from '@/core/schema';
import { TARGET_URLS } from '@/shared/urls';

const STORAGE_KEY_POS = 'cira.pill.position';

interface SavedPosition {
  x: number;
  y: number;
}

const PILL_TEMPLATE = document.createElement('template');
PILL_TEMPLATE.innerHTML = `
<style>
  :host {
    all: initial;
    position: fixed;
    z-index: 2147483646;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  *, *::before, *::after {
    box-sizing: border-box;
  }
  .pill-wrap {
    position: relative;
    width: 40px;
    height: 40px;
    transition: width 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.35s ease;
  }
  .pill-wrap:hover,
  .pill-wrap.open {
    width: 190px;
  }
  .pill-inner {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    height: 100%;
    padding: 3px;
    border-radius: 999px;
    background: #16161d;
    border: 1px solid #2a2a38;
    cursor: grab;
    user-select: none;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    animation: enterSpring 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both,
               glowPulse 3s ease-in-out infinite 0.45s;
    overflow: hidden;
  }
  .pill-wrap.dragging .pill-inner {
    cursor: grabbing;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
  }
  .pill-icon {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    line-height: 1;
    background: #00d4aa;
    border-radius: 50%;
    color: #0f0f12;
    z-index: 1;
  }
  .pill-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 16px;
    padding-left: 10px;
    font-size: 12px;
    font-weight: 600;
    color: #e8e8ed;
    letter-spacing: 0.01em;
    opacity: 0;
    transition: opacity 0.18s ease 0.05s;
  }
  .pill-wrap:hover .pill-label,
  .pill-wrap.open .pill-label {
    opacity: 1;
  }
  @keyframes enterSpring {
    0% { transform: scale(0.3); opacity: 0; }
    60% { transform: scale(1.08); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes glowPulse {
    0%, 100% { box-shadow: 0 4px 16px rgba(0,212,170,0.15); }
    50% { box-shadow: 0 4px 24px rgba(0,212,170,0.35), 0 0 48px rgba(0,212,170,0.08); }
  }
  .menu {
    position: absolute;
    bottom: 48px;
    right: 0;
    min-width: 220px;
    background: #1a1a24;
    border: 1px solid #2a2a38;
    border-radius: 12px;
    padding: 6px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.4);
    opacity: 0;
    transform: translateY(8px) scale(0.96);
    pointer-events: none;
    transition: opacity 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
                transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .menu.visible {
    opacity: 1;
    transform: translateY(0) scale(1);
    pointer-events: auto;
  }
  .menu-section {
    font-size: 10px;
    font-weight: 700;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 6px 10px 2px;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    font-size: 12.5px;
    color: #c8c8d2;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    font-family: inherit;
  }
  .menu-item:hover {
    background: #2a2a38;
    color: #00d4aa;
  }
  .menu-item.download-item:hover {
    color: #f49b3e;
  }
  .menu-item .arrow {
    color: #00d4aa;
    font-size: 13px;
    flex-shrink: 0;
  }
  .menu-item.download-item .arrow {
    color: #f49b3e;
  }
  .menu-divider {
    height: 1px;
    background: #2a2a38;
    margin: 4px 8px;
  }
</style>
<div class="pill-wrap" part="pill-wrap">
  <div class="pill-inner" part="pill-inner">
    <div class="pill-icon" part="pill-icon">\u26A1</div>
    <div class="pill-label" part="pill-label">Relay to...</div>
  </div>
  <div class="menu" part="menu"></div>
</div>
`;

class CiraRelayPill extends HTMLElement {
  private _wrap: HTMLElement | null = null;
  private _label: HTMLElement | null = null;
  private _menu: HTMLElement | null = null;
  private _dragging = false;
  private _didDrag = false;
  private _dragStart = { x: 0, y: 0 };
  private _pos = { x: 16, y: 16 };
  private _visible = true;
  private _menuOpen = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.appendChild(PILL_TEMPLATE.content.cloneNode(true));
  }

  connectedCallback() {
    this._wrap = this.shadowRoot!.querySelector('.pill-wrap')!;
    this._label = this.shadowRoot!.querySelector('.pill-label')!;
    this._menu = this.shadowRoot!.querySelector('.menu')!;
    this._loadPosition();
    this._positionPill();
    this._bindEvents();
    this._buildMenu();
  }

  private async _loadPosition() {
    try {
      const domainKey = `${STORAGE_KEY_POS}.${location.hostname}`;
      const result = await chrome.storage.local.get(domainKey);
      const saved = result[domainKey] as SavedPosition | undefined;
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        this._pos = { x: saved.x, y: saved.y };
      } else {
        this.style.right = '16px';
        this.style.bottom = '16px';
      }
    } catch {
      this.style.right = '16px';
      this.style.bottom = '16px';
    }
  }

  private async _savePosition() {
    try {
      const domainKey = `${STORAGE_KEY_POS}.${location.hostname}`;
      await chrome.storage.local.set({ [domainKey]: { x: this._pos.x, y: this._pos.y } });
    } catch {
    }
  }

  private _positionPill() {
    const style = this.style;
    style.right = '';
    style.bottom = '';
    style.left = 'auto';
    style.top = 'auto';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (this._pos.x < vw / 2) {
      style.left = `${Math.max(0, this._pos.x)}px`;
    } else {
      style.right = `${Math.max(0, vw - this._pos.x)}px`;
    }
    if (this._pos.y < vh / 2) {
      style.top = `${Math.max(0, this._pos.y)}px`;
    } else {
      style.bottom = `${Math.max(0, vh - this._pos.y)}px`;
    }
  }

  private _bindEvents() {
    if (!this._wrap || !this._menu) return;

    this._wrap.querySelector('.pill-inner')!.addEventListener('pointerdown', (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.button === 2) {
        e.preventDefault();
        this._toggleVisibility();
        return;
      }
      if ((pe.target as HTMLElement).closest('.menu-item')) return;
      this._onDragStart(pe);
    });

    this._wrap.addEventListener('click', (e: Event) => {
      if (this._didDrag) {
        this._didDrag = false;
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest('.menu-item')) return;
      if (this._menuOpen) {
        this._closeMenu();
      } else {
        this._openMenu();
      }
    });

    document.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this._dragging) return;
      this._onDragMove(e);
    });

    document.addEventListener('pointerup', () => {
      if (!this._dragging) return;
      this._onDragEnd();
    });

    this._wrap.addEventListener('contextmenu', (e: Event) => {
      e.preventDefault();
      this._toggleVisibility();
    });

    document.addEventListener('click', (e: Event) => {
      if (!this._menuOpen) return;
      const path = e.composedPath();
      if (path.includes(this)) return;
      this._closeMenu();
    });
  }

  private _onDragStart(e: PointerEvent) {
    this._dragging = true;
    this._didDrag = false;
    this._dragStart = { x: e.clientX - this._pos.x, y: e.clientY - this._pos.y };
    this._wrap!.classList.add('dragging');
    try {
      (this._wrap!.querySelector('.pill-inner') as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
    }
  }

  private _onDragMove(e: PointerEvent) {
    const dx = e.clientX - this._dragStart.x - this._pos.x;
    const dy = e.clientY - this._dragStart.y - this._pos.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      this._didDrag = true;
    }
    this._pos.x = Math.max(0, Math.min(window.innerWidth - 190, e.clientX - this._dragStart.x));
    this._pos.y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - this._dragStart.y));
    this._positionPill();
  }

  private _onDragEnd() {
    this._dragging = false;
    this._wrap!.classList.remove('dragging');
    this._savePosition();
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
    const platforms = getAllPlatforms().filter((p) => p.id !== sourceId);

    const frag = document.createDocumentFragment();

    const section = document.createElement('div');
    section.className = 'menu-section';
    section.textContent = 'Continue in';
    frag.appendChild(section);

    for (const p of platforms) {
      const item = this._createTargetItem(p.id, p.name);
      frag.appendChild(item);
    }

    const sourceDef = getAllPlatforms().find((p) => p.id === sourceId);
    if (sourceDef) {
      const selfItem = this._createTargetItem(sourceDef.id, `New ${sourceDef.name} tab`);
      selfItem.setAttribute('data-new-tab', 'true');
      frag.appendChild(selfItem);
    }

    const divider = document.createElement('div');
    divider.className = 'menu-divider';
    frag.appendChild(divider);

    const downloadSection = document.createElement('div');
    downloadSection.className = 'menu-section';
    downloadSection.textContent = 'Download';
    frag.appendChild(downloadSection);

    const mdItem = this._createDownloadItem('Markdown', 'md');
    frag.appendChild(mdItem);

    const jsonItem = this._createDownloadItem('JSON', 'json');
    frag.appendChild(jsonItem);

    this._menu.innerHTML = '';
    this._menu.appendChild(frag);
  }

  private _createTargetItem(id: string, name: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    btn.innerHTML = `<span class="arrow">\u2192</span> ${name}`;
    btn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      this._handleRelay(id);
    });
    return btn;
  }

  private _createDownloadItem(label: string, format: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'menu-item download-item';
    btn.innerHTML = `<span class="arrow">\u2193</span> ${label}`;
    btn.addEventListener('click', async (e: Event) => {
      e.stopPropagation();
      this._handleDownload(format);
    });
    return btn;
  }

  private async _handleRelay(target: string) {
    this._closeMenu();
    if (!this._label) return;
    const prev = this._label.textContent;
    this._label.textContent = 'Extracting...';
    try {
      const conversation = extractConversation();
      if (conversation.messages.length === 0) {
        this._label.textContent = 'No messages';
        window.setTimeout(() => { if (this._label) this._label!.textContent = prev; }, 2000);
        return;
      }
      const msg: RuntimeMessage = {
        type: 'CIRA/STAGE_RELAY',
        target: target as Source,
        payload: { conversation, summary: '' },
      };
      await chrome.runtime.sendMessage(msg);
      this._label.textContent = 'Opening...';
      this._navigateToTarget(target as Source);
      window.setTimeout(() => { if (this._label) this._label!.textContent = 'Relay to...'; }, 2000);
    } catch (err) {
      console.error('[CIRA] relay failed', err);
      this._label.textContent = 'Failed';
      window.setTimeout(() => { if (this._label) this._label!.textContent = prev; }, 2000);
    }
  }

  private _navigateToTarget(target: Source) {
    window.open(TARGET_URLS[target] || 'https://chatgpt.com/', '_blank', 'noopener');
  }

  private async _handleDownload(format: string) {
    this._closeMenu();
    try {
      const conversation = extractConversation();
      if (format === 'json') {
        const blob = new Blob([JSON.stringify(conversation, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${conversation.title.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const md = conversation.messages
          .map((m) => `## ${m.role}\n\n${m.content}`)
          .join('\n\n---\n\n');
        const blob = new Blob([`# ${conversation.title}\n\n${md}`], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${conversation.title.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_')}.md`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('[CIRA] download failed', err);
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
