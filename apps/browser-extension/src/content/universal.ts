import { createRelayPill } from '@/content/relay-pill';
import { extractConversation } from '@/adapters/extract';
import { injectPrompt } from '@/adapters/inject';
import { detectSource } from '@/platform/detect';
import { onDomChange } from '@/shared/dom';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Source } from '@/shared/schema';
import { createRateLimitDetector } from '@/platform/rate-limit-detection';
import type { AIPlatform } from '@/platform/rate-limit-detection';

// Canonical platform detection (same function the popup and side panel use).
const source: Source = detectSource(location.href);

let cleanupRateLimit: (() => void) | null = null;
let pillMounted = false;

// 1. Messaging FIRST. Optional features below must never be able to stop the
//    extension from reaching this tab (Phase 01 bug: an exception during
//    start-up left the side panel with "Reload this tab to activate CIRA.").
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case 'CIRA/EXTRACT_REQUEST': {
      extractConversation().then(
        (conversation) => sendResponse({ type: 'CIRA/EXTRACT_RESPONSE', conversation } satisfies RuntimeMessage),
        (err: unknown) => {
          console.error('[CIRA][content] extraction failed', err);
          sendResponse({ type: 'CIRA/EXTRACT_ERROR', error: err instanceof Error ? err.message : String(err) } satisfies RuntimeMessage);
        },
      );
      return true;
    }

    case 'CIRA/POP_STAGED': {
      handlePopStaged(msg.for).then((ok) => sendResponse({ ok }));
      return true;
    }

    case 'CIRA/PING': {
      // Handshake used by the side panel / popup to confirm this script is live.
      sendResponse({ type: 'CIRA/PONG', source } satisfies RuntimeMessage);
      return false;
    }

    case 'CIRA/SHOW_BANNER': {
      showBanner(msg.message, msg.level);
      return false;
    }

    default:
      return false;
  }
});

// 2. Optional features, each isolated.
function mountPill(): void {
  if (pillMounted) return;
  try {
    createRelayPill();
    pillMounted = true;
  } catch (err) {
    console.error('[CIRA][content] relay pill failed to mount', err);
  }
}

function startRateLimitMonitoring(): void {
  if (cleanupRateLimit || source === 'unknown') return;
  try {
    cleanupRateLimit = createRateLimitDetector({
      platform: source as AIPlatform,
      onRateLimit(detection) {
        chrome.runtime.sendMessage({
          type: 'CIRA/RATE_LIMIT_DETECTED',
          source: detection.platform as Source,
          timestamp: Date.now(),
        } satisfies RuntimeMessage).catch(() => { });
      },
      debounceMs: 5000,
    });
  } catch (err) {
    console.error('[CIRA][content] rate-limit monitoring failed to start', err);
  }
}

mountPill();
onDomChange(() => {
  mountPill();
}, 500);
startRateLimitMonitoring();

// Hidden unless DevTools "Verbose" level is enabled.
console.debug(`[CIRA][content] initialized ┬╖ source detected: ${source}`);

async function handlePopStaged(for_: string): Promise<boolean> {
  const reply = (await chrome.runtime.sendMessage({
    type: 'CIRA/POP_STAGED',
    for: for_ as Source,
  } satisfies RuntimeMessage)) as RuntimeMessage | undefined;

  if (!reply || reply.type !== 'CIRA/POP_STAGED_RESPONSE' || !reply.payload) return false;

  const ok = await injectPrompt(reply.payload.summary);
  if (ok) {
    showBanner('CIRA: context injected. Review, then press Send.', 'info');
  } else {
    showBanner('CIRA: could not find input box.', 'error');
  }
  return ok;
}

function showBanner(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const id = 'cira-universal-banner';
  let el = document.getElementById(id) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = id;
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
      transition: 'opacity 0.3s ease',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
  }
  el.style.background = level === 'error' ? '#dc2626' : level === 'warn' ? '#f49b3e' : '#00b392';
  el.textContent = text;
  el.style.opacity = '1';
  window.setTimeout(() => {
    el!.style.opacity = '0';
    window.setTimeout(() => el?.remove(), 400);
  }, 4000);
}

window.setTimeout(() => {
  const currentPlatform = source;
  if (currentPlatform !== 'unknown') {
    void (async () => {
      const reply = (await chrome.runtime.sendMessage({
        type: 'CIRA/POP_STAGED',
        for: currentPlatform,
      } satisfies RuntimeMessage)) as RuntimeMessage | undefined;

      if (!reply || reply.type !== 'CIRA/POP_STAGED_RESPONSE' || !reply.payload) return;

      const ok = await injectPrompt(reply.payload.summary);
      if (ok) {
        showBanner('CIRA: context from another platform injected. Review, then press Send.', 'info');
      } else {
        showBanner('CIRA: could not find input box.', 'error');
      }
    })();
  }
}, 1500);
