import type { Conversation, Source } from '@/core/schema';

export interface Adapter {
    /** Stable identifier from `Source`. */
    id: Source;
    /** Friendly name shown in the UI. */
    name: string;
    /** Hostnames this adapter claims, lower-cased and exact-matched. */
    hostMatchers: RegExp[];
    /** CSS selector for the message-composer input box. */
    composerSelectors: string[];
    /** Read the current conversation. Caller is the side panel, on user demand. */
    extract(): Promise<Conversation>;
}

export interface AdapterContext {
    href: string;
    hostname: string;
}

export function makeMeta(source: Source, host: string, title: string): {
    source: Source;
    url: string;
    title: string;
    capturedAt: string;
} {
    return {
        source,
        url: typeof location !== 'undefined' ? location.href : `https://${host}/`,
        title: cleanTitle(title),
        capturedAt: new Date().toISOString(),
    };
}

function cleanTitle(raw: string): string {
    return raw
        .replace(/\s*[-|·–—]\s*[A-Za-z .]+$/u, '')
        .trim()
        || 'Conversation';
}
