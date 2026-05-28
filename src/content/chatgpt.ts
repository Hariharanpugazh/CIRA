/**
 * ChatGPT content script.
 *
 * Responsibilities:
 *   1. Inject a floating "Send to Claude" button.
 *   2. On click: extract conversation -> compress -> stage in storage -> open Claude.
 *   3. Respond to background EXTRACT_REQUEST messages from the popup.
 */
import { extractChatGPT } from '@/core/extractors/chatgpt';
import { compress } from '@/core/compress';
import { onDomChange } from '@/shared/dom';
import type { RuntimeMessage } from '@/shared/messaging';

const BTN_ID = 'cira-send-to-claude';

function createButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.textContent = '→ Send to Claude';
  btn.title = 'CIRA: extract this conversation and continue in Claude';
  Object.assign(btn.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '2147483647',
    padding: '10px 14px',
    background: '#7c3aed',
    color: 'white',
    border: '0',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
  } satisfies Partial<CSSStyleDeclaration>);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Extracting...';
    try {
      const conversation = extractChatGPT();
      if (conversation.messages.length === 0) {
        btn.textContent = 'No messages found';
        return;
      }
      const summary = compress(conversation);
      const msg: RuntimeMessage = {
        type: 'CIRA/STAGE_RELAY',
        target: 'claude',
        payload: { conversation, summary },
      };
      await chrome.runtime.sendMessage(msg);
      btn.textContent = 'Opening Claude...';
      window.open('https://claude.ai/new', '_blank', 'noopener');
      window.setTimeout(() => {
        btn.textContent = prev;
        btn.disabled = false;
      }, 1500);
    } catch (err) {
      console.error('[CIRA] extract failed', err);
      btn.textContent = 'Failed — see console';
      window.setTimeout(() => {
        btn.textContent = prev;
        btn.disabled = false;
      }, 2000);
    }
  });

  return btn;
}

function ensureButton(): void {
  if (document.getElementById(BTN_ID)) return;
  document.body.appendChild(createButton());
}

// Re-inject on SPA navigations.
ensureButton();
onDomChange(ensureButton, 500);

// Allow popup to request a snapshot.
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'CIRA/EXTRACT_REQUEST') {
    const conversation = extractChatGPT();
    const response: RuntimeMessage = {
      type: 'CIRA/EXTRACT_RESPONSE',
      conversation,
    };
    sendResponse(response);
    return true;
  }
  return false;
});
