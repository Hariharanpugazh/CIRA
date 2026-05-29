import { db } from '@/core/db';

let sessionId: string | null = null;

function getSessionId(): string {
  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }
  return sessionId;
}

export async function track(
  event: string,
  properties?: Record<string, number | string>,
): Promise<void> {
  await db.analytics.add({
    sessionId: getSessionId(),
    timestamp: new Date().toISOString(),
    event,
    properties: properties ?? {},
  });
}

export async function getDailyTransfers(
  days = 30,
): Promise<Array<{ date: string; count: number }>> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();

  const events = await db.analytics
    .where('event')
    .equals('relay.sent')
    .and((e) => e.timestamp >= cutoffIso)
    .toArray();

  const counts = new Map<string, number>();
  for (const e of events) {
    const date = e.timestamp.slice(0, 10);
    counts.set(date, (counts.get(date) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getTotalTokensSaved(): Promise<number> {
  const events = await db.analytics
    .where('event')
    .equals('relay.sent')
    .toArray();

  let total = 0;
  for (const e of events) {
    const tokenEstimate = e.properties.estimatedTokensSaved;
    if (typeof tokenEstimate === 'number') {
      total += tokenEstimate;
    }
  }

  return total;
}

export async function getTopSources(
  limit = 10,
): Promise<Array<{ source: string; count: number }>> {
  const events = await db.analytics.toArray();

  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event === 'conversation.captured' && e.properties.source) {
      const src = String(e.properties.source);
      counts.set(src, (counts.get(src) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
