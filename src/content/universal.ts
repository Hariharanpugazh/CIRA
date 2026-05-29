import { createRelayPill } from '@/content/relay-pill';
import { extractConversation } from '@/core/extractors/universal';
import { injectPrompt } from '@/core/injectors/universal';
import { getPlatformId } from '@/core/platforms/registry';
import { onDomChange } from '@/shared/dom';
import type { RuntimeMessage } from '@/shared/messaging';
import type { Source } from '@/core/schema';
import { createRateLimitDetector, detectPlatformFromURL } from '@/core/rate-limit-detection';
import type { AIPlatform } from '@/core/rate-limit-detection';

let cleanupRateLimit: (() => void) | null = null;
let pillMounted = false;

function mountPill(): void {
  if (pillMounted) return;
  try {
    createRelayPill();
    pillMounted = true;
  } catch {
  }
}

function startRateLimitMonitoring(): void {
  if (cleanupRateLimit) return;

  const platform = detectPlatformFromURL();
  if (!platform) return;

  cleanupRateLimit = createRateLimitDetector({
    platform: platform as AIPlatform,
    onRateLimit(detection) {
      chrome.runtime.sendMessage({
        type: 'CIRA/RATE_LIMIT_DETECTED',
        source: detection.platform as Source,
        timestamp: Date.now(),
      } satisfies RuntimeMessage).catch(() => { });
    },
    debounceMs: 5000,
  });
}

mountPill();
onDomChange(() => {
  mountPill();
}, 500);

startRateLimitMonitoring();

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case 'CIRA/EXTRACT_REQUEST': {
      void extractConversation().then((conversation) => {
        sendResponse({
          type: 'CIRA/EXTRACT_RESPONSE',
          conversation,
        } satisfies RuntimeMessage);
      });
      return true;
    }

    case 'CIRA/POP_STAGED': {
      handlePopStaged(msg.for).then((ok) => sendResponse({ ok }));
      return true;
    }

    case 'CIRA/PING': {
      sendResponse({ type: 'CIRA/PONG' } satisfies RuntimeMessage);
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
  const currentPlatform = getPlatformId();
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
