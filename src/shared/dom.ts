import { detectSource } from '@/shared/utils';

export function getPlatformFromURL(url?: string): string {
  return detectSource(url);
}

export function waitForElement<T extends Element = Element>(
  selector: string,
  timeoutMs = 10_000,
  root: ParentNode = document,
): Promise<T | null> {
  const existing = root.querySelector<T>(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const found = root.querySelector<T>(selector);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.setTimeout(() => {
      observer.disconnect();
      resolve(root.querySelector<T>(selector));
    }, timeoutMs);
  });
}

export function onDomChange(cb: () => void, debounceMs = 250): () => void {
  let t: number | undefined;
  const observer = new MutationObserver(() => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(cb, debounceMs);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

export function cleanText(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function injectScript(func: () => void): void {
  const script = document.createElement('script');
  script.textContent = `(${func.toString()})();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

export function interceptFetch(onLimit: (url: string) => void): () => void {
  const originalFetch = window.fetch.bind(window);

  const patchedFetch: typeof fetch = async (input, init) => {
    let urlStr = '';
    if (typeof input === 'string') {
      urlStr = input;
    } else if (input instanceof Request) {
      urlStr = input.url;
    } else {
      urlStr = input.toString();
    }

    const res = await originalFetch(input, init);

    if (!res.ok && (res.status === 429 || res.status === 403)) {
      const body = await res.clone().text().catch(() => '');
      const rateLimitKeywords = ['rate_limit', 'rate limit', 'too many requests', 'quota'];
      if (rateLimitKeywords.some((kw) => body.toLowerCase().includes(kw))) {
        onLimit(urlStr);
      }
    }

    return res;
  };

  window.fetch = patchedFetch;
  return () => {
    window.fetch = originalFetch;
  };
}

export function fingerprint(elements: Element[]): string {
  const parts = elements.map((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    const bubbles =
      clone.querySelectorAll('[class*="tooltip"], [class*="popover"], [class*="toast"], [class*="menu"], [role="tooltip"], [role="menu"]') ??
      [];
    bubbles.forEach((b) => b.remove());
    return clone.textContent ?? '';
  });
  return hashString(parts.join('\n'));
}

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash.toString(36);
}
