import { waitForElement } from '@/shared/dom';
import { getPlatformDefForUrl } from '@/core/platforms/registry';

async function findInput(): Promise<HTMLElement | null> {
  const def = getPlatformDefForUrl(location.href);
  for (const sel of def.injector.inputSelectors) {
    try {
      const el = await waitForElement<HTMLElement>(sel, 4_000);
      if (el) return el;
    } catch {
      continue;
    }
  }
  const genericSel = ['textarea', 'div[contenteditable="true"]', '[role="textbox"]'];
  for (const sel of genericSel) {
    try {
      const el = await waitForElement<HTMLElement>(sel, 2_000);
      if (el) return el;
    } catch {
      continue;
    }
  }
  return null;
}

export async function injectPrompt(text: string): Promise<boolean> {
  const input = await findInput();
  if (!input) return false;

  const def = getPlatformDefForUrl(location.href);

  if (input instanceof HTMLTextAreaElement || def.injector.type === 'textarea') {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  input.focus();

  try {
    input.textContent = '';
  } catch {
  }

  try {
    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('delete');
  } catch {
  }

  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) {
    try {
      (input as HTMLElement).innerText = text;
    } catch {
      input.textContent = text;
    }
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return true;
}
