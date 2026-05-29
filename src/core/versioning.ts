import { diff_match_patch as DMP } from 'diff-match-patch';

const dmp = new DMP();

const STORAGE_PREFIX = 'cira_versions_';
const CHECKPOINT_INTERVAL = 10;

interface VersionRecord {
  version: number;
  message: string;
  timestamp: string;
  isCheckpoint: boolean;
  fullContent: string | null;
  patchText: string | null;
}

interface VersionEntry {
  versions: VersionRecord[];
}

async function loadVersions(conversationId: number): Promise<VersionRecord[]> {
  const key = STORAGE_PREFIX + conversationId;
  const result = await chrome.storage.local.get(key);
  const entry = result[key] as VersionEntry | undefined;
  return entry?.versions ?? [];
}

async function saveVersions(conversationId: number, versions: VersionRecord[]): Promise<void> {
  const key = STORAGE_PREFIX + conversationId;
  await chrome.storage.local.set({ [key]: { versions } });
}

function reconstructContent(versions: VersionRecord[], targetVersion: number): string {
  const sorted = [...versions].filter((v) => v.version <= targetVersion).sort((a, b) => a.version - b.version);

  let baseContent = '';
  let startVersion = 0;

  for (const r of sorted) {
    if (r.isCheckpoint && r.fullContent) {
      baseContent = r.fullContent;
      startVersion = r.version;
    }
  }

  if (startVersion === targetVersion) return baseContent;

  for (const r of sorted) {
    if (r.version <= startVersion) continue;
    if (r.patchText) {
      const patch = dmp.patch_fromText(r.patchText);
      const [result] = dmp.patch_apply(patch, baseContent);
      baseContent = result;
    }
  }

  return baseContent;
}

export async function commit(
  conversationId: number,
  content: string,
  message: string,
): Promise<number> {
  const versions = await loadVersions(conversationId);
  const nextVersion = versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.version)) + 1;
  const shouldCheckpoint = nextVersion % CHECKPOINT_INTERVAL === 0 || nextVersion === 1;

  let patchText: string | null = null;

  if (nextVersion > 1) {
    const baseContent = reconstructContent(versions, nextVersion - 1);
    const diffs = dmp.diff_main(baseContent, content);
    dmp.diff_cleanupSemantic(diffs);
    const patches = dmp.patch_make(baseContent, diffs);
    patchText = dmp.patch_toText(patches);
  }

  const record: VersionRecord = {
    version: nextVersion,
    message,
    timestamp: new Date().toISOString(),
    isCheckpoint: shouldCheckpoint,
    fullContent: shouldCheckpoint ? content : null,
    patchText: shouldCheckpoint ? null : patchText,
  };

  versions.push(record);
  await saveVersions(conversationId, versions);
  return nextVersion;
}

export async function getHistory(
  conversationId: number,
): Promise<Array<{ version: number; message: string; timestamp: string }>> {
  const versions = await loadVersions(conversationId);
  return versions.map((v) => ({
    version: v.version,
    message: v.message,
    timestamp: v.timestamp,
  }));
}

export async function getVersion(
  conversationId: number,
  version: number,
): Promise<string> {
  const versions = await loadVersions(conversationId);
  return reconstructContent(versions, version);
}

export async function rollback(
  conversationId: number,
  version: number,
): Promise<void> {
  const content = await getVersion(conversationId, version);
  await commit(conversationId, content, `Rollback to version ${version}`);
}

export async function getCurrentContent(conversationId: number): Promise<string> {
  const versions = await loadVersions(conversationId);
  if (versions.length === 0) return '';
  const latestVersion = Math.max(...versions.map((v) => v.version));
  return reconstructContent(versions, latestVersion);
}

export async function deleteVersions(conversationId: number): Promise<void> {
  const key = STORAGE_PREFIX + conversationId;
  await chrome.storage.local.remove(key);
}
