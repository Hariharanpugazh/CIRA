/**
 * IndexedDB storage for large media bundles.
 *
 * chrome.storage.session is capped at 10 MB. For conversations with images,
 * files, and other attachments, we offload binary assets to IndexedDB and
 * keep only metadata/text in chrome.storage.session.
 *
 *   chrome.storage.session → text content + asset hashes
 *   IndexedDB              → binary blobs (images, files) keyed by hash
 *
 * DB structure:
 *   DB: CIRA_Assets
 *   Object store: assets (key: asset_id, value: { dataUrl, mime, name, createdAt })
 */

const DB_NAME = 'CIRA_Assets';
const DB_VERSION = 1;
const STORE_NAME = 'assets';

export interface AssetRecord {
  id: string;
  dataUrl: string;
  mime: string;
  name: string;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * Store an asset by its content hash.
 * Returns the asset ID (SHA-256-like hash, but for pragmatic reasons we
 * use a fast hash of the first + last bytes + length).
 */
export async function storeAsset(
  dataUrl: string,
  name: string,
): Promise<string> {
  const id = hashDataUrl(dataUrl);
  const mime = dataUrl.match(/^data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const db = await openDB();

  // Skip if already stored.
  const existing = await getAsset(id);
  if (existing) return id;

  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE_NAME, 'readwrite');
    const store = txn.objectStore(STORE_NAME);
    const record: AssetRecord = {
      id,
      dataUrl,
      mime,
      name,
      createdAt: Date.now(),
    };
    store.add(record);
    txn.oncomplete = () => resolve(id);
    txn.onerror = () => reject(txn.error);
  });
}

/**
 * Retrieve an asset by its ID.
 */
export function getAsset(id: string): Promise<AssetRecord | null> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const txn = db.transaction(STORE_NAME, 'readonly');
        const store = txn.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      }),
  );
}

/**
 * Store multiple assets and return their IDs.
 */
export async function storeAssets(
  assets: { dataUrl: string; name: string }[],
): Promise<string[]> {
  return Promise.all(assets.map((a) => storeAsset(a.dataUrl, a.name)));
}

/**
 * Delete assets older than maxAgeMs.
 */
export async function pruneOldAssets(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE_NAME, 'readwrite');
    const store = txn.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (cursor.value.createdAt < cutoff) {
        store.delete(cursor.primaryKey);
      }
      cursor.continue();
    };
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
  });
}

/**
 * Get estimated storage usage (in bytes).
 * Returns the sum of all stored data URLs' byte sizes.
 */
export async function getStorageSize(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const txn = db.transaction(STORE_NAME, 'readonly');
    const store = txn.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const total = (req.result as AssetRecord[]).reduce(
        (sum, r) => sum + r.dataUrl.length,
        0,
      );
      resolve(total);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Fast content-based hash for deduplication. */
function hashDataUrl(dataUrl: string): string {
  // Combine first 50 chars, last 50 chars, and length.
  const head = dataUrl.slice(0, 50);
  const tail = dataUrl.slice(-50);
  const combined = head + tail + dataUrl.length;

  // djb2 hash.
  let hash = 5381;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 33) ^ combined.charCodeAt(i);
  }
  return 'asset_' + (hash >>> 0).toString(36);
}
