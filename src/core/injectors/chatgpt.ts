/**
 * Inject a prepared prompt into ChatGPT's composer.
 *
 * ChatGPT currently uses a ProseMirror contenteditable (id="prompt-textarea")
 * in addition to a hidden textarea fallback.
 */
import { waitForElement } from '@/shared/dom';

const INPUT_SELECTORS = [
  '#prompt-textarea',
  'div[contenteditable="true"].ProseMirror',
  'textarea[data-id="root"]',
  'textarea',
];

async function findInput(): Promise<HTMLElement | null> {
  for (const sel of INPUT_SELECTORS) {
    const el = await waitForElement<HTMLElement>(sel, 4_000);
    if (el) return el;
  }
  return null;
}

export async function injectIntoChatGPT(prompt: string): Promise<boolean> {
  const input = await findInput();
  if (!input) return false;

  if (input instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(input, prompt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // contenteditable path
  input.focus();
  const range = document.createRange();
  range.selectNodeContents(input);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('delete');

  const inserted = document.execCommand('insertText', false, prompt);
  if (!inserted) {
    input.innerText = prompt;
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText' }),
    );
  }
  return true;
}
