import { encode } from 'gpt-tokenizer';

/** GPT-tokenizer token count (used for the popup's size estimate only). */
export function countTokens(text: string): number {
  return encode(text).length;
}
