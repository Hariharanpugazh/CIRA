/**
 * Small DOM helpers shared by content scripts.
 */

/**
 * Wait for an element matching `selector` to appear, or resolve null after `timeoutMs`.
 */
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

/**
 * Run `cb` whenever the DOM mutates, debounced.
 */
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

/**
 * Collapse whitespace and trim.
 */
export function cleanText(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
