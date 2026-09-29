/**
 * ContextStore backed by `chrome.storage.local` (the manifest grants
 * `unlimitedStorage`). All logic lives in Core's KeyValueContextStore; this
 * file only supplies the Chrome storage area.
 */
import { KeyValueContextStore, type KeyValueArea } from '@cira/core';

export class ChromeContextStore extends KeyValueContextStore {
  constructor(area: KeyValueArea = chrome.storage.local as unknown as KeyValueArea) {
    super(area, { prefix: 'cira.pco.' });
  }
}
