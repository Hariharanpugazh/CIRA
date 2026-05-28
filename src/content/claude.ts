/**
 * Claude content script.
 *
 * On load: ask the background for any staged relay payload addressed to Claude.
 * If found, inject the compressed summary into the input box and surface a small
 * banner so the user can confirm or dismiss before sending.
 */
import { injectIntoClaude } from '@/core/injectors/claude';
import { extractClaude } from '@/core/extractors/claude';
import { waitForElement } from '@/shared/dom';
import type { RuntimeMessage } from '@/shared/messaging';

const BANNER_ID = 'cira-relay-banner';

function showBanner(text: string, kind: 'ok' | 'err' = 'ok'): void {
  let el = document.getElementById(BANNER_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = BANNER_ID;
    Object.assign(el.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: '2147483647',
      padding: '10px 14px',
      borderRadius: '10px',
      fontSize: '13px',
      fontWeight: '600',
      color: 'white',
      boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
      maxWidth: '320px',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
  }
  el.style.background = kind === 'ok' ? '#16a34a' : '#dc2626';
  el.textContent = text;
  window.setTimeout(() => el?.remove(), 4000);
}

async function tryInjectStaged(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({
    type: 'CIRA/POP_STAGED',
    for: 'claude',
  } satisfies RuntimeMessage)) as RuntimeMessage | undefined;

  if (!reply || reply.type !== 'CIRA/POP_STAGED_RESPONSE' || !reply.payload) return;

  // Wait briefly for Claude's editor to mount.
  await waitForElement('div[contenteditable="true"]', 8_000);
  const ok = await injectIntoClaude(reply.payload.summary);
  showBanner(
    ok
      ? 'CIRA: context from ChatGPT injected. Review, then press Send.'
      : 'CIRA: could not find Claude input box.',
    ok ? 'ok' : 'err',
  );
}

// Allow popup to request a snapshot of a Claude conversation too.
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'CIRA/EXTRACT_REQUEST') {
    const conversation = extractClaude();
    const response: RuntimeMessage = {
      type: 'CIRA/EXTRACT_RESPONSE',
      conversation,
    };
    sendResponse(response);
    return true;
  }
  return false;
});

void tryInjectStaged();
