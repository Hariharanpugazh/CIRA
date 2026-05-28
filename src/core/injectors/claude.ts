/**
 * Inject a prepared prompt into Claude's input box.
 *
 * Claude uses a ProseMirror contenteditable. We must mutate the DOM and
 * dispatch input events so React state syncs.
 */
import { waitForElement } from '@/shared/dom';

const INPUT_SELECTORS = [
  'div[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
];

async function findInput(): Promise<HTMLElement | null> {
  for (const sel of INPUT_SELECTORS) {
    const el = await waitForElement<HTMLElement>(sel, 4_000);
    if (el) return el;
  }
  return null;
}

function setProseMirrorText(el: HTMLElement, text: string): void {
  el.focus();
  // Replace existing content.
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('delete');

  // ProseMirror listens for `beforeinput` of type "insertText".
  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) {
    // Fallback: write paragraphs directly.
    el.innerText = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }
}

export async function injectIntoClaude(prompt: string): Promise<boolean> {
  const input = await findInput();
  if (!input) return false;
  setProseMirrorText(input, prompt);
  return true;
}
