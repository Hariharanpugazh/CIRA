/**
 * AI Platform Rate-Limit Detection Strategies
 * ===========================================
 *
 * Research on detecting rate limits from Chrome extension content scripts
 * for 10 major AI platforms. Each strategy uses a combination of:
 *
 *   1. DOM-level detection (MutationObserver watching for known error text)
 *   2. fetch/XHR interception (429 status codes, rate-limit headers)
 *   3. API response shape inspection (error.type, error.code fields)
 *
 * All selectors and patterns are best-effort snapshots that may drift as
 * each platform updates their UI.  Always layer multiple signals.
 */

// ---------------------------------------------------------------------------
// 0. SHARED INFRASTRUCTURE — fetch/XHR interception
// ---------------------------------------------------------------------------

/**
 * Intercept fetch() in the page context to detect 429 responses.
 *
 * Strategy: monkey-patch window.fetch. The content script runs in the
 * "main world" when using `world: 'MAIN'` in manifest V3, or we inject
 * a <script> that runs in-page. For isolated-world content scripts,
 * we use `window.postMessage` bridging (see fetchBridge below).
 */
export function instrumentFetch(onRateLimit: (details: FetchRateLimitEvent) => void): () => void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await originalFetch(input, init);
    const cloned = response.clone();

    // Check status code + rate-limit headers asynchronously (fire-and-forget).
    void cloned.text().then((_body) => {
      if (response.status === 429) {
        onRateLimit({
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          status: 429,
          retryAfter: response.headers.get('retry-after'),
          ratelimitRequestsRemaining: response.headers.get('x-ratelimit-remaining-requests'),
          ratelimitTokensRemaining: response.headers.get('x-ratelimit-remaining-tokens'),
          anthropicRequestsRemaining: response.headers.get(
            'anthropic-ratelimit-requests-remaining',
          ),
          anthropicTokensRemaining: response.headers.get(
            'anthropic-ratelimit-tokens-remaining',
          ),
          timestamp: Date.now(),
        });
      }
    }).catch(() => {
      // Response body may have already been consumed; ignore.
    });

    return response;
  };

  return () => {
    window.fetch = originalFetch;
  };
}

/** Shape emitted when fetch/XHR returns a rate-limit signal. */
export interface FetchRateLimitEvent {
  url: string;
  status: 429;
  retryAfter: string | null;
  ratelimitRequestsRemaining: string | null;
  ratelimitTokensRemaining: string | null;
  anthropicRequestsRemaining: string | null;
  anthropicTokensRemaining: string | null;
  timestamp: number;
}

/**
 * Intercept XMLHttpRequest similarly. This is relevant for older SPAs
 * that still use XHR for streaming chat completions.
 */
export function instrumentXHR(onRateLimit: (details: FetchRateLimitEvent) => void): () => void {
  const OriginalXHR = window.XMLHttpRequest;

  window.XMLHttpRequest = class PatchedXHR extends OriginalXHR {
    private _url = '';

    open(method: string, url: string | URL, async = true, username: string | null = null, password: string | null = null): void {
      this._url = typeof url === 'string' ? url : url.href;
      super.open(method, url as string, async, username, password);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const onReady = () => {
        if (this.readyState === 4 && this.status === 429) {
          onRateLimit({
            url: this.responseURL || this._url,
            status: 429,
            retryAfter: this.getResponseHeader('retry-after'),
            ratelimitRequestsRemaining: this.getResponseHeader('x-ratelimit-remaining-requests'),
            ratelimitTokensRemaining: this.getResponseHeader('x-ratelimit-remaining-tokens'),
            anthropicRequestsRemaining: this.getResponseHeader(
              'anthropic-ratelimit-requests-remaining',
            ),
            anthropicTokensRemaining: this.getResponseHeader(
              'anthropic-ratelimit-tokens-remaining',
            ),
            timestamp: Date.now(),
          });
        }
      };
      this.addEventListener('readystatechange', onReady, { once: true });
      super.send(body);
    }
  };

  return () => {
    window.XMLHttpRequest = OriginalXHR;
  };
}

// ---------------------------------------------------------------------------
// 1. MUTATIONOBSERVER — watching for DOM-based rate-limit UI
// ---------------------------------------------------------------------------

/**
 * Generic MutationObserver wrapper that scans for rate-limit text in the DOM.
 *
 * Platforms like ChatGPT, Claude, and Gemini render inline error banners or
 * toast notifications when you hit a limit.  Rather than polling the DOM,
 * we observe childList + subtree mutations and check new nodes against a
 * platform-specific regex.
 */
export function watchDOMForRateLimit(
  patterns: RegExp[],
  selectors: string[],
  onDetected: (matches: RegExpMatchArray, sourceNode: Node) => void,
): () => void {
  const checkNode = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;

      // 1. Check text content of the node itself.
      const text = el.textContent ?? '';
      for (const p of patterns) {
        const m = p.exec(text);
        if (m) {
          onDetected(m, node);
          return;
        }
      }

      // 2. Check selector-specific targets within the node.
      for (const sel of selectors) {
        const targets = el.matches(sel) ? [el] : Array.from(el.querySelectorAll(sel));
        for (const t of targets) {
          const tText = t.textContent ?? '';
          for (const p of patterns) {
            const m = p.exec(tText);
            if (m) {
              onDetected(m, t);
              return;
            }
          }
        }
      }
    }
  };

  // Scan existing DOM immediately.
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      checkNode(el);
    }
  }
  // Also scan body text as a fallback.
  checkNode(document.body);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        checkNode(node);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => observer.disconnect();
}

// ---------------------------------------------------------------------------
// 2. PER-PLATFORM RATE-LIMIT DETECTION STRATEGIES
// ---------------------------------------------------------------------------

/** Platform identifier used across the extension. */
export type AIPlatform =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'deepseek'
  | 'perplexity'
  | 'copilot'
  | 'grok'
  | 'kimi'
  | 'qwen'
  | 'poe'
  | 'huggingchat'
  | 'notebooklm'
  | 'you'
  | 'characterai'
  | 'pi'
  | 'zai'
  | 'mistral';

/** Result of a rate-limit check on a given platform. */
export interface RateLimitDetection {
  platform: AIPlatform;
  detected: boolean;
  source: 'dom' | 'fetch' | 'xhr' | 'unknown';
  /** The raw error message captured (if any). */
  message: string;
  /** CSS selector of the element that contained the rate-limit text. */
  selector?: string;
  /** How long until retry (seconds), if available. */
  retryAfterSeconds?: number;
  /** ISO timestamp of detection. */
  timestamp: string;
}

// ---------------------------------------------------------------------------

/**
 * ChatGPT (chat.openai.com / chatgpt.com)
 *
 * --- DOM signals ---
 * ChatGPT renders rate-limit UI in several places:
 *
 * 1. INLINE ERROR BANNER — a "You've hit the Free plan limit" or
 *    "You've reached the current usage cap" banner near the top of the chat
 *    panel. Selector: `.text-token-text-error` container, or
 *    `[class*="error"]` inside `main` area.
 *
 * 2. TOAST/NOTIFICATION — bottom-right corner toast. Historically uses
 *    a div with role="alert" or a Snackbar-like component.
 *
 * 3. COMPOSER POPOVER — when the textarea is disabled, a small popover
 *    may read "You've reached your GPT-4o limit. Upgrade to Plus" or
 *    "Upgrade to Plus to continue". Selector: `[class*="upsell"]` near
 *    `#prompt-textarea`.
 *
 * 4. OVERLAY/MODAL — occasionally shows a full-screen modal with plan
 *    upgrade prompt.
 *
 * --- Error messages (regex-ready) ---
 *   "You['']ve reached the current usage cap"
 *   "You['']ve hit the (Free|usage) limit"
 *   "You['']ve reached your (GPT-4|GPT-4o|usage) limit"
 *   "Upgrade to (Plus|Pro|Team)"
 *   "usage cap" / "rate limit" / "too many requests"
 *   "Free plan"
 *   "Get Plus" / "Subscribe to Plus"
 *
 * --- API signals ---
 * ChatGPT's in-page fetch calls go to `chatgpt.com/backend-api/conversation`
 * or `chat.openai.com/backend-api/conversation`.  On 429:
 *   - `x-ratelimit-limit-requests`
 *   - `x-ratelimit-remaining-requests`
 *   - `x-ratelimit-reset-requests`
 *   - `x-ratelimit-limit-tokens`
 *   - `x-ratelimit-remaining-tokens`
 *   - `x-ratelimit-reset-tokens`
 *
 * --- Approximate rate limits (2026, web UI, not API) ---
 *   Free (GPT-4o): ~10 msgs/3 hrs, dropping to GPT-4o-mini after
 *   Free (GPT-4o-mini): unlimited, but throttled after heavy use
 *   Plus ($20/mo): ~80 msgs/3 hrs GPT-4o, ~40 GPT-4.1, fallback to mini
 *   Pro ($200/mo): near-unlimited access
 */
export const CHATGPT_RATE_LIMIT_SELECTORS = [
  // Inline error text in the chat panel
  '[class*="text-token-text-error"]',
  '[class*="text-error"]',
  // Toast/snackbar notification
  '[role="alert"]',
  '[class*="toast"]',
  '[class*="notification"]',
  // Plan upsell near the composer
  '[class*="upsell"]',
  // Modal overlay
  '[role="dialog"] [class*="limit"]',
  '[role="dialog"] [class*="upgrade"]',
  // Banner above chat
  '[class*="banner"]',
  // Disabled textarea signal
  '#prompt-textarea[disabled]',
  // Generic (ChatGPT wraps limits in markdown or plain divs)
  '.text-center p',
];

export const CHATGPT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /You'?ve (reached|hit) the (current )?usage (cap|limit)/i,
  /You'?ve (reached|hit) (the|your) (Free|GPT-4|GPT-4o|GPT-4\.\d) (plan )?(limit|cap|usage)/i,
  /You'?ve (reached|exceeded) your (current )?(quota|usage)/i,
  /You'?ve hit the rate limit/i,
  /Too many requests/i,
  /upgrade to (Plus|Pro|Team)/i,
  /Get (Plus|Pro) to continue/i,
  /Subscribe to Plus/i,
  /rate limit reached/i,
  /Your access to (GPT-4|GPT-4o) is (temporarily )?limited/i,
  /Try again (after|in|in about)/i,
  /You are currently on the Free plan/i,
];

/** The backend endpoints ChatGPT uses for chat conversations. */
export const CHATGPT_API_URL_PATTERNS = [
  /chatgpt\.com\/backend-api\/conversation/,
  /chat\.openai\.com\/backend-api\/conversation/,
  /chatgpt\.com\/backend-api\/conversations/,
  /chat\.openai\.com\/backend-api\/conversations/,
];

// ---------------------------------------------------------------------------

/**
 * Claude (claude.ai)
 *
 * --- DOM signals ---
 * Claude's UI is built with React + Tailwind. Rate-limit UI appears as:
 *
 * 1. MESSAGE-INTERRUPTION BUBBLE — an assistant-like message bubble that
 *    says "Rate limit reached" or "You've used all your messages for now".
 *    Selector: `.font-claude-message` container with limit text.
 *
 * 2. PLAN-UPSELL BANNER — a sticky banner at the bottom or top reading
 *    "You've reached your free plan limit. Upgrade to Pro for more."
 *    Selector: `[class*="upsell"]` or `[class*="banner"]` in the chat area.
 *
 * 3. TOAST — top-right or bottom-right toast notification.
 *
 * 4. COMPOSER DISABLE — the ProseMirror input becomes read-only or shows
 *    a "You've reached the limit" tooltip.
 *
 * --- Error messages ---
 *   "Rate limit reached"
 *   "Message limit reached"
 *   "Conversation limit reached"
 *   "Usage limit reached"
 *   "You['']ve used all your messages"
 *   "You['']ve reached the free plan limit"
 *   "Wait X (minutes|hours)"
 *   "Resets at" / "Reset in"
 *   "Upgrade to Pro" / "Try Pro"
 *
 * --- API signals (claude.ai frontend calls to claude.ai/api/*) ---
 *   429 with headers:
 *     - `anthropic-ratelimit-requests-limit`
 *     - `anthropic-ratelimit-requests-remaining`
 *     - `anthropic-ratelimit-requests-reset`
 *     - `anthropic-ratelimit-tokens-limit`
 *     - `anthropic-ratelimit-tokens-remaining`
 *     - `anthropic-ratelimit-tokens-reset`
 *     - `retry-after`
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free: ~10-15 msgs per conversation before bumping to Haiku; daily cap
 *   Pro ($20/mo): ~45 msgs/5 hours on Sonnet 4; unlimited on Haiku
 *   Max ($100/mo): higher limits on Opus 4
 *   Team ($25/user/mo): similar to Pro with shared limits
 */
export const CLAUDE_RATE_LIMIT_SELECTORS = [
  // Assistant-like message containing limit text
  '.font-claude-message',
  '[data-testid="user-message"] + div',
  // Banners
  '[class*="banner"]',
  '[class*="alert"]',
  // Toast
  '[role="alert"]',
  '[class*="toast"]',
  // Upsell
  '[class*="upsell"]',
  '[class*="upgrade"]',
  // Disabled input indicator
  'div[contenteditable="true"][aria-disabled="true"]',
  'div[contenteditable="true"][data-placeholder*="limit" i]',
  // Modal / dialog
  '[role="dialog"]',
  '[class*="modal"]',
  // General text blocks in message area
  'article p',
  // Limit counter
  '[class*="usage"]',
  '[class*="remaining"]',
];

export const CLAUDE_RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate limit reached/i,
  /message limit reached/i,
  /conversation limit reached/i,
  /usage limit reached/i,
  /you'?ve (reached|hit|exceeded)/i,
  /you'?ve used all your messages/i,
  /free plan limit/i,
  /upgrade to (Pro|Max|Team)/i,
  /try Pro/i,
  /resets?\s+(at|in)\s+/i,
  /wait\s+(\d+)\s*(minute|hour|second)/i,
  /you'?re out of (free )?messages/i,
  /limit\s+(\d+)\s+hours/i,
];

export const CLAUDE_API_URL_PATTERNS = [
  /claude\.ai\/api\//,
  /claude\.ai\/api\/chat/,
  /claude\.ai\/api\/organizations\//,
  /api\.claude\.ai\//,
];

// ---------------------------------------------------------------------------

/**
 * Gemini (gemini.google.com)
 *
 * --- DOM signals ---
 * Google's Gemini uses Material Design 3 web components.
 * Rate-limit UI appears as:
 *
 * 1. INLINE ERROR — "Gemini isn't available right now. Try again later."
 *    or "There was an error. Try again" — this is the most common rate
 *    limit signal, shown as an assistant bubble in the chat area.
 *
 * 2. BANNER — top of page reading "You've reached a usage limit."
 *
 * 3. TOAST — MD3 snackbar at the bottom.
 *
 * --- Error messages ---
 *   "Gemini (isn't|is not) available (right now|at the moment)"
 *   "Please try again (later|in a few minutes)"
 *   "Something went wrong"
 *   "Try again"
 *   "Usage quota exceeded"
 *   "Too many requests"
 *   "You've reached a limit"
 *
 * --- API signals ---
 * Gemini's in-page calls go to `generativelanguage.googleapis.com` or
 * internal Google APIs.  429 responses come with:
 *   - `retry-after`
 *   - GRPC-style status in JSON body
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free: ~50 msgs/day for Gemini 2.5 Pro (advanced models);
 *         unlimited for Flash models (2.5 Flash, etc.)
 *   Google One AI Premium ($19.99/mo): significantly higher limits on Pro
 *   models, access to Ultra/experimental
 *   Note: Google rarely shows explicit "rate limit" text; instead the model
 *   simply refuses or the UI shows a generic "not available" error.
 */
export const GEMINI_RATE_LIMIT_SELECTORS = [
  // Error messages in message bubbles
  '[class*="error"]',
  '[class*="error-message"]',
  // MD3 snackbar / toast
  'md-snackbar',
  '[class*="snackbar"]',
  '[class*="toast"]',
  // Banner
  '[class*="banner"]',
  '[class*="alert"]',
  // Inline error text
  '.response-container [class*="error"]',
  // Chat message containers
  '[role="list"] [class*="message"]',
  // Generic error presentation
  '[class*="warning"]',
  // The "something went wrong" state
  'mat-icon[data-mat-icon-name="error"]',
];

export const GEMINI_RATE_LIMIT_PATTERNS: RegExp[] = [
  /Gemini\s+(isn'?t|is\s+not)\s+available\s+(right\s+now|at\s+the\s+moment)/i,
  /please\s+try\s+again\s+(later|in\s+a\s+few\s+minutes)/i,
  /usage\s+quota\s+exceeded/i,
  /too\s+many\s+requests/i,
  /you'?ve\s+reached\s+a\s+limit/i,
  /rate\s+limit\s+exceeded/i,
  /something\s+went\s+wrong/i,
  /try\s+again\s+later/i,
  /currently\s+unavailable/i,
  /resource\s+has\s+been\s+exhausted/i,
  /RESOURCE_EXHAUSTED/i,
];

export const GEMINI_API_URL_PATTERNS = [
  /generativelanguage\.googleapis\.com/,
  /gemini\.google\.com\/_\/BatchedChatAjax/,
  /gemini\.googleapis\.com/,
];

// ---------------------------------------------------------------------------

/**
 * DeepSeek (chat.deepseek.com)
 *
 * --- DOM signals ---
 * DeepSeek's web chat is relatively simple. Rate limits show as:
 *
 * 1. MODAL — a modal dialog that says "Daily limit reached" or
 *    "You've reached the daily usage limit" (in English or Chinese).
 *
 * 2. INLINE MESSAGE — an assistant-like message bubble saying the limit
 *    has been reached.
 *
 * 3. COMPOSER DISABLE — the textarea becomes disabled with overlay text.
 *
 * --- Error messages (bilingual: EN + ZH) ---
 *   "Daily limit reached" / "今日使用次数已达上限"
 *   "You've reached the daily usage limit" / "您已达到每日使用上限"
 *   "Too many requests" / "请求过于频繁"
 *   "Rate limit" / "频率限制"
 *   "Try again in XX minutes" / "请在XX分钟后重试"
 *   "Server is busy" / "服务器繁忙"
 *
 * --- API signals ---
 *   429 with `retry-after` header.
 *   Concurrency limits: 500 for deepseek-v4-pro, 2500 for deepseek-v4-flash.
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free: ~100 msgs/day (all models); generous compared to western platforms
 *   No paid tier for web UI as of 2026 (API is paid, web is free)
 *   During peak hours (China daytime), limits may be stricter
 *   "Server busy" is a de-facto rate limit during high traffic
 */
export const DEEPSEEK_RATE_LIMIT_SELECTORS = [
  '[class*="modal"]',
  '[class*="dialog"]',
  '[role="alertdialog"]',
  '[class*="toast"]',
  '[class*="notification"]',
  '[class*="limit"]',
  '[class*="banner"]',
  'textarea[disabled]',
  '.ds-markdown',
  '[class*="message"] p',
];

export const DEEPSEEK_RATE_LIMIT_PATTERNS: RegExp[] = [
  /每日.*(上限|限制|次数)/,
  /daily\s+limit\s+reached/i,
  /you'?ve\s+reached\s+the\s+daily\s+(usage\s+)?limit/i,
  /too\s+many\s+requests/i,
  /请求过于频繁/,
  /服务器繁忙/,
  /server\s+is\s+busy/i,
  /rate\s+limit/i,
  /频率限制/,
  /稍后重试/,
  /try\s+again\s+(in|after|later)/i,
  /usage\s+limit\s+reached/i,
  /已达到.*上限/,
];

export const DEEPSEEK_API_URL_PATTERNS = [
  /chat\.deepseek\.com\/api\//,
  /api\.deepseek\.com\//,
  /deepseek\.com\/api\//,
];

// ---------------------------------------------------------------------------

/**
 * Perplexity (perplexity.ai)
 *
 * --- DOM signals ---
 * Perplexity uses a React/Next.js SPA. Rate limits appear as:
 *
 * 1. TOAST — bottom-center toast that says "You've reached the daily
 *    limit for Pro searches.  Upgrade to Pro for unlimited."
 *
 * 2. SEARCH-LIMIT BADGE — a counter badge showing "X/5 Pro searches used".
 *
 * 3. UPGRADE MODAL — full-screen modal promoting Pro upgrade.
 *
 * --- Error messages ---
 *   "You've reached the daily limit for Pro searches"
 *   "You've used all your Pro searches for today"
 *   "Upgrade to Pro for unlimited searches"
 *   "X searches remaining today"
 *   "Too many requests"
 *
 * --- API signals ---
 *   Perplexity's internal API calls return 429 with Perplexity-specific
 *   headers (not standard x-ratelimit-*).
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free: ~5 Pro searches/day; unlimited Quick searches
 *   Pro ($20/mo): ~300-600 Pro searches/day; unlimited Quick
 *   Enterprise: custom limits
 */
export const PERPLEXITY_RATE_LIMIT_SELECTORS = [
  '[class*="toast"]',
  '[class*="notification"]',
  '[class*="snackbar"]',
  '[class*="banner"]',
  '[role="alert"]',
  '[class*="upsell"]',
  '[class*="upgrade"]',
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="remaining"]',
  '[class*="limit"]',
];

export const PERPLEXITY_RATE_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve\s+reached\s+(the\s+)?daily\s+limit/i,
  /you'?ve\s+used\s+all\s+your\s+Pro\s+searches/i,
  /upgrade\s+to\s+Pro/i,
  /(\d+)\s+searches?\s+remaining/i,
  /too\s+many\s+requests/i,
  /rate\s+limit/i,
  /upgrade\s+for\s+unlimited/i,
  /daily\s+quota\s+reached/i,
  /free\s+plan\s+limit/i,
];

export const PERPLEXITY_API_URL_PATTERNS = [
  /perplexity\.ai\/api\//,
  /www\.perplexity\.ai\/api\//,
  /perplexity\.ai\/rest\//,
];

// ---------------------------------------------------------------------------

/**
 * GitHub Copilot (github.com/copilot — IDE/web extensions)
 *
 * NOTE: Copilot is primarily an IDE plugin and GitHub web feature,
 * not a standalone chat website. Rate limits apply to:
 *
 * 1. IDE completions (Ghost Text in-editor)
 * 2. IDE Chat messages
 * 3. GitHub.com Copilot Chat (web)
 * 4. Copilot agentic features (project mode, PR review)
 *
 * For a Chrome extension, the relevant context is the GitHub.com Copilot
 * Chat widget (appears as a floating panel on github.com pages) and
 * the github.com/copilot page.
 *
 * --- DOM signals (GitHub.com) ---
 *   GitHub Copilot Chat renders as a web component or React tree.
 *   Rate limit typically appears as a message in the chat panel:
 *     "You've reached the usage limit for Copilot Chat"
 *     "Copilot Free: X/50 messages used this month"
 *     "(Upgrade|Try) Copilot Pro for more messages"
 *
 * --- Approximate rate limits (2026) ---
 *   Free: 2000 code completions/month, 50 chat msgs/month
 *   Pro ($10/mo): unlimited completions, 300 chat msgs/month
 *   Pro+ ($39/mo): unlimited completions, unlimited chat, agentic features
 *   Business/Enterprise ($19-39/user/mo): similar to Pro+ with admin controls
 *
 * --- API signals ---
 *   Copilot's internal API uses GitHub's backend.
 *   429 on `/copilot/` or `/copilot_internal/` endpoints.
 */
export const COPILOT_RATE_LIMIT_SELECTORS = [
  // GitHub Copilot Chat panel
  '[class*="copilot-chat"]',
  '[class*="copilot"] [class*="message"]',
  // Limit indicator
  '[class*="usage"]',
  '[class*="limit"]',
  // Toast/banner on github.com
  '[class*="flash"]',
  '[class*="toast"]',
  '[role="alert"]',
  // Upgrade prompt
  '[class*="upsell"]',
];

export const COPILOT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve\s+reached\s+the\s+usage\s+limit/i,
  /copilot\s+(free|chat)\s+limit\s+reached/i,
  /(\d+)\/\d+\s+messages?\s+used/i,
  /upgrade\s+(to\s+)?Copilot\s+Pro/i,
  /you'?ve\s+used\s+all\s+(your\s+)?(free\s+)?(chat\s+)?messages/i,
  /monthly\s+limit\s+reached/i,
];

export const COPILOT_API_URL_PATTERNS = [
  /github\.com\/copilot/,
  /api\.github\.com\/copilot/,
  /github\.com\/_copilot_chat/,
];

// ---------------------------------------------------------------------------

/**
 * Grok (grok.com / x.com/i/grok)
 *
 * --- DOM signals ---
 * Grok's web UI is on x.com (formerly Twitter). Rate limits appear as:
 *
 * 1. INLINE MESSAGE — a message in the chat feed saying "You've reached
 *    the rate limit. Please try again later."
 *
 * 2. TOAST — X-style toast at top of page.
 *
 * 3. COMPOSER OVERLAY — the input box is disabled with a "Rate limit
 *    reached" tooltip.
 *
 * --- Error messages ---
 *   "You've reached the rate limit"
 *   "Too many requests"
 *   "Please try again later"
 *   "You've hit the limit for grok-[model]"
 *   "Wait XX minutes"
 *
 * --- API signals ---
 *   Grok on x.com calls internal X/Twitter APIs.
 *   Grok API (api.x.ai) returns 429 with standard headers.
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free (x.com): ~10 queries/2 hours for Grok model
 *   X Premium ($8/mo): ~50 queries/2 hours
 *   X Premium+ ($16/mo): higher limits, access to Grok 4
 *   API (api.x.ai): tiered per cumulative spend (T0: 1800 RPM, 10M TPM)
 */
export const GROK_RATE_LIMIT_SELECTORS = [
  '[class*="grok"] [class*="error"]',
  '[class*="grok"] [class*="limit"]',
  '[class*="toast"]',
  '[class*="notification"]',
  '[role="alert"]',
  '[class*="banner"]',
  'textarea[disabled]',
  '[class*="message"]',
];

export const GROK_RATE_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve\s+reached\s+the\s+rate\s+limit/i,
  /too\s+many\s+requests/i,
  /please\s+try\s+again\s+later/i,
  /you'?ve\s+hit\s+the\s+limit/i,
  /wait\s+(\d+)\s*(minute|hour|second)/i,
  /upgrade\s+(to|your)\s+(Premium|X\s+Premium)/i,
  /grok.*limit/i,
  /message\s+limit\s+reached/i,
  /usage\s+limit/i,
];

export const GROK_API_URL_PATTERNS = [
  /x\.com\/i\/api\/graphql/,
  /api\.x\.ai\/v\d\//,
  /grok\.com\/api\//,
];

// ---------------------------------------------------------------------------

/**
 * Kimi (kimi.moonshot.cn)
 *
 * --- DOM signals ---
 * Kimi is Moonshot AI's consumer chatbot. Uses a Next.js-like SPA.
 * Rate limits show as:
 *
 * 1. MODAL — a modal dialog reading "今日使用次数已达上限" (Daily usage
 *    limit reached) or "你已达到每日使用上限" (You've reached daily limit).
 *
 * 2. INLINE ERROR — a chat bubble with limit text.
 *
 * 3. COMPOSER DISABLE — input box disabled with limit message.
 *
 * --- Error messages (Chinese + occasional English) ---
 *   "今日使用次数已达上限" / "You've reached the daily usage limit"
 *   "高峰期，请稍后再试" / "Peak hours, please try again later"
 *   "请求过于频繁" / "Too many requests"
 *   "服务繁忙" / "Service is busy"
 *   "对话次数已用完" / "Conversation count exhausted"
 *
 * --- API signals ---
 *   Kimi's API returns 429 with `retry-after` for the platform API.
 *   The web UI may show different limits from the API.
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free: ~100 msgs/day (generous), file uploads limited
 *   No paid consumer tier; platform.kimi.ai for developers
 */
export const KIMI_RATE_LIMIT_SELECTORS = [
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="toast"]',
  '[class*="notification"]',
  '[class*="error"]',
  '[class*="limit"]',
  'textarea[disabled]',
  '[class*="kimi"] [class*="alert"]',
];

export const KIMI_RATE_LIMIT_PATTERNS: RegExp[] = [
  /今日.*(上限|限制|次数)/,
  /已达到.*(上限|限制)/,
  /对话.*(用完|上限)/,
  /高峰期.*(稍后|再试)/,
  /请求过于频繁/,
  /服务繁忙/,
  /you'?ve\s+reached\s+the\s+daily\s+limit/i,
  /too\s+many\s+requests/i,
  /peak\s+hours/i,
  /service\s+is\s+busy/i,
  /次数.*(上限|用完|达到)/,
  /daily\s+usage\s+limit/i,
];

export const KIMI_API_URL_PATTERNS = [
  /kimi\.moonshot\.cn\/api\//,
  /api\.moonshot\.cn\//,
];

// ---------------------------------------------------------------------------

/**
 * Qwen (Tongyi Qianwen — tongyi.aliyun.com / chat.qwen.ai)
 *
 * --- DOM signals ---
 * Qwen is Alibaba's AI assistant. The web chat is on `tongyi.aliyun.com`.
 *
 * 1. TOAST/BANNER — "今日免费额度已用完" (Today's free quota exhausted)
 *    or "您已达到今日使用上限" (You've reached today's usage limit).
 *
 * 2. COMPOSER DISABLE — input disabled with quota message.
 *
 * 3. MODAL — upgrade/充值 (top-up) modal.
 *
 * --- Error messages (Chinese) ---
 *   "今日免费额度已用完" / "Quota exhausted for today"
 *   "请求过于频繁，请稍后再试" / "Too many requests, try later"
 *   "服务繁忙" / "Service busy"
 *   "达到使用上限" / "Usage limit reached"
 *   "当前模型不可用" / "Current model unavailable"
 *
 * --- API signals ---
 *   DashScope API (Alibaba Cloud) returns 429 with standard headers.
 *   ThrottlingBanding: Alibaba uses throttling bands.
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free: ~100 msgs/day (varies by model)
 *   Qwen Plus (via Alibaba Cloud): pay-per-token
 */
export const QWEN_RATE_LIMIT_SELECTORS = [
  '[class*="toast"]',
  '[class*="notification"]',
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="banner"]',
  '[class*="alert"]',
  '[class*="error"]',
  '[class*="limit"]',
  '[class*="quota"]',
  'textarea[disabled]',
  '[class*="tongyi"] [class*="tip"]',
];

export const QWEN_RATE_LIMIT_PATTERNS: RegExp[] = [
  /免费额度.*(用完|耗尽|达到)/,
  /今日.*(上限|限制|额度)/,
  /已达到.*上限/,
  /请求过于频繁/,
  /服务繁忙/,
  /quota\s+exhausted/i,
  /too\s+many\s+requests/i,
  /usage\s+limit\s+reached/i,
  /当前.*不可用/,
  /请稍后再试/,
  /稍后.*重试/,
  /daily\s+limit\s+reached/i,
];

export const QWEN_API_URL_PATTERNS = [
  /tongyi\.aliyun\.com\/api\//,
  /chat\.qwen\.ai\/api\//,
  /dashscope\.aliyuncs\.com/,
];

// ---------------------------------------------------------------------------

/**
 * Poe (poe.com)
 *
 * --- DOM signals ---
 * Poe by Quora is a multi-model chat platform. Rate limits appear as:
 *
 * 1. TOAST — bottom toast: "You've reached your daily message limit"
 *    or "You've used all your messages for today."
 *
 * 2. PAYWALL OVERLAY — full-screen overlay: "Subscribe to continue" with
 *    plan options.
 *
 * 3. MODEL-SPECIFIC LIMIT — per-model message counter showing remaining
 *    messages for each bot.
 *
 * 4. COMPOSER DISABLE — "Subscribe to continue chatting" placeholder.
 *
 * --- Error messages ---
 *   "You've reached your daily message limit"
 *   "You've used all your messages for [model]"
 *   "Subscribe to continue"
 *   "Daily limit reached"
 *   "XX messages remaining today"
 *   "Rate limit exceeded"
 *
 * --- API signals ---
 *   Poe uses internal GraphQL endpoints on `poe.com/api/`.
 *   429 responses with `retry-after`.
 *
 * --- Approximate web UI rate limits (2026) ---
 *   Free: ~10 msgs/day (standard models), ~1-3 (premium models)
 *   Poe Subscriber ($19.99/mo): 1M compute points/month
 *     (varying cost per model; cheaper models allow more messages)
 *   Poe does not have traditional "rate limits" — it uses a compute-point
 *   quota system where each model costs different points per message.
 */
export const POE_RATE_LIMIT_SELECTORS = [
  '[class*="toast"]',
  '[class*="notification"]',
  '[class*="alert"]',
  '[role="alert"]',
  '[class*="overlay"]',
  '[class*="upsell"]',
  '[class*="subscribe"]',
  '[class*="paywall"]',
  '[class*="limit"]',
  '[class*="remaining"]',
  '[class*="banner"]',
  'textarea[disabled][placeholder*="Subscribe" i]',
  'textarea[disabled][placeholder*="limit" i]',
];

export const POE_RATE_LIMIT_PATTERNS: RegExp[] = [
  /you'?ve\s+reached\s+(your\s+)?daily\s+(message\s+)?limit/i,
  /you'?ve\s+used\s+all\s+your\s+messages/i,
  /subscribe\s+to\s+continue/i,
  /daily\s+limit\s+reached/i,
  /(\d+)\s+messages?\s+remaining/i,
  /rate\s+limit\s+exceeded/i,
  /too\s+many\s+requests/i,
  /comput(e|ing)\s+points?\s+(exhausted|remaining)/i,
  /out\s+of\s+messages/i,
  /upgrade\s+(your\s+)?plan/i,
];

export const POE_API_URL_PATTERNS = [
  /poe\.com\/api\//,
  /poe\.com\/gql/,
];

// ---------------------------------------------------------------------------
// 3. PLATFORM CONFIGURATION MAP
// ---------------------------------------------------------------------------

/** All the configuration for a single AI platform. */
export interface PlatformRateLimitConfig {
  platform: AIPlatform;
  domainPatterns: RegExp[];
  selectors: string[];
  textPatterns: RegExp[];
  apiUrlPatterns: RegExp[];
  /** Known API response headers specific to rate-limiting (for 429). */
  rateLimitHeaderKeys: string[];
}

export const PLATFORM_CONFIGS: Record<AIPlatform, PlatformRateLimitConfig> = {
  chatgpt: {
    platform: 'chatgpt',
    domainPatterns: [/chat\.openai\.com/, /chatgpt\.com/],
    selectors: CHATGPT_RATE_LIMIT_SELECTORS,
    textPatterns: CHATGPT_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: CHATGPT_API_URL_PATTERNS,
    rateLimitHeaderKeys: [
      'x-ratelimit-limit-requests',
      'x-ratelimit-limit-tokens',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-reset-requests',
      'x-ratelimit-reset-tokens',
    ],
  },
  claude: {
    platform: 'claude',
    domainPatterns: [/claude\.ai/],
    selectors: CLAUDE_RATE_LIMIT_SELECTORS,
    textPatterns: CLAUDE_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: CLAUDE_API_URL_PATTERNS,
    rateLimitHeaderKeys: [
      'anthropic-ratelimit-requests-limit',
      'anthropic-ratelimit-requests-remaining',
      'anthropic-ratelimit-requests-reset',
      'anthropic-ratelimit-tokens-limit',
      'anthropic-ratelimit-tokens-remaining',
      'anthropic-ratelimit-tokens-reset',
      'anthropic-ratelimit-input-tokens-limit',
      'anthropic-ratelimit-input-tokens-remaining',
      'anthropic-ratelimit-input-tokens-reset',
      'anthropic-ratelimit-output-tokens-limit',
      'anthropic-ratelimit-output-tokens-remaining',
      'anthropic-ratelimit-output-tokens-reset',
      'retry-after',
    ],
  },
  gemini: {
    platform: 'gemini',
    domainPatterns: [/gemini\.google\.com/],
    selectors: GEMINI_RATE_LIMIT_SELECTORS,
    textPatterns: GEMINI_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: GEMINI_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after'],
  },
  deepseek: {
    platform: 'deepseek',
    domainPatterns: [/chat\.deepseek\.com/, /deepseek\.com/],
    selectors: DEEPSEEK_RATE_LIMIT_SELECTORS,
    textPatterns: DEEPSEEK_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: DEEPSEEK_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after'],
  },
  perplexity: {
    platform: 'perplexity',
    domainPatterns: [/perplexity\.ai/, /www\.perplexity\.ai/],
    selectors: PERPLEXITY_RATE_LIMIT_SELECTORS,
    textPatterns: PERPLEXITY_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: PERPLEXITY_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after'],
  },
  copilot: {
    platform: 'copilot',
    domainPatterns: [/copilot\.microsoft\.com/, /microsoft\.copilot/, /bing\.com\/chat/],
    selectors: COPILOT_RATE_LIMIT_SELECTORS,
    textPatterns: COPILOT_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: COPILOT_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after', 'x-ratelimit-remaining'],
  },
  grok: {
    platform: 'grok',
    domainPatterns: [/x\.com/, /grok\.com/],
    selectors: GROK_RATE_LIMIT_SELECTORS,
    textPatterns: GROK_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: GROK_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after'],
  },
  kimi: {
    platform: 'kimi',
    domainPatterns: [/kimi\.moonshot\.cn/],
    selectors: KIMI_RATE_LIMIT_SELECTORS,
    textPatterns: KIMI_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: KIMI_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after'],
  },
  qwen: {
    platform: 'qwen',
    domainPatterns: [/tongyi\.aliyun\.com/, /chat\.qwen\.ai/],
    selectors: QWEN_RATE_LIMIT_SELECTORS,
    textPatterns: QWEN_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: QWEN_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after'],
  },
  poe: {
    platform: 'poe',
    domainPatterns: [/poe\.com/],
    selectors: POE_RATE_LIMIT_SELECTORS,
    textPatterns: POE_RATE_LIMIT_PATTERNS,
    apiUrlPatterns: POE_API_URL_PATTERNS,
    rateLimitHeaderKeys: ['retry-after'],
  },
  huggingchat: {
    platform: 'huggingchat',
    domainPatterns: [/huggingface\.co\/chat/],
    selectors: ['[class*="rate-limit"]', '[class*="error"]', '[role="alert"]'],
    textPatterns: [/rate limit/i, /too many/i, /try again/i, /quota/i, /upgrade/i],
    apiUrlPatterns: [/api\//, /rest\//],
    rateLimitHeaderKeys: ['retry-after'],
  },
  notebooklm: {
    platform: 'notebooklm',
    domainPatterns: [/notebooklm\.google\.com/],
    selectors: ['[class*="rate-limit"]', '[class*="error"]', '[role="alert"]'],
    textPatterns: [/rate limit/i, /too many/i, /try again/i, /quota/i, /upgrade/i],
    apiUrlPatterns: [/api\//, /rest\//],
    rateLimitHeaderKeys: ['retry-after'],
  },
  you: {
    platform: 'you',
    domainPatterns: [/you\.com/],
    selectors: ['[class*="rate-limit"]', '[class*="error"]', '[role="alert"]'],
    textPatterns: [/rate limit/i, /too many/i, /try again/i, /quota/i, /upgrade/i],
    apiUrlPatterns: [/api\//, /rest\//],
    rateLimitHeaderKeys: ['retry-after'],
  },
  characterai: {
    platform: 'characterai',
    domainPatterns: [/character\.ai/],
    selectors: ['[class*="rate-limit"]', '[class*="error"]', '[role="alert"]'],
    textPatterns: [/rate limit/i, /too many/i, /try again/i, /quota/i, /upgrade/i],
    apiUrlPatterns: [/api\//, /rest\//],
    rateLimitHeaderKeys: ['retry-after'],
  },
  pi: {
    platform: 'pi',
    domainPatterns: [/pi\.ai/],
    selectors: ['[class*="rate-limit"]', '[class*="error"]', '[role="alert"]'],
    textPatterns: [/rate limit/i, /too many/i, /try again/i, /quota/i, /upgrade/i],
    apiUrlPatterns: [/api\//, /rest\//],
    rateLimitHeaderKeys: ['retry-after'],
  },
  zai: {
    platform: 'zai',
    domainPatterns: [/z\.ai/],
    selectors: ['[class*="rate-limit"]', '[class*="error"]', '[role="alert"]'],
    textPatterns: [/rate limit/i, /too many/i, /try again/i, /quota/i, /upgrade/i],
    apiUrlPatterns: [/api\//, /rest\//],
    rateLimitHeaderKeys: ['retry-after'],
  },
  mistral: {
    platform: 'mistral',
    domainPatterns: [/chat\.mistral\.ai/, /mistral\.ai/],
    selectors: ['[class*="rate-limit"]', '[class*="error"]', '[role="alert"]'],
    textPatterns: [/rate limit/i, /too many/i, /try again/i, /quota/i, /upgrade/i],
    apiUrlPatterns: [/api\//, /rest\//],
    rateLimitHeaderKeys: ['retry-after'],
  },
};

// ---------------------------------------------------------------------------
// 4. DETECT CURRENT PLATFORM FROM URL
// ---------------------------------------------------------------------------

export function detectPlatformFromURL(url: string = location.href): AIPlatform | null {
  for (const config of Object.values(PLATFORM_CONFIGS)) {
    for (const pattern of config.domainPatterns) {
      if (pattern.test(url)) return config.platform;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. UNIFIED DETECTOR FACTORY
// ---------------------------------------------------------------------------

/**
 * Create a rate-limit detector for the current page.
 * Returns a cleanup function that disconnects all observers and interceptors.
 */
export interface RateLimitDetectorOptions {
  platform: AIPlatform;
  /** Called whenever a rate limit is detected by any method. */
  onRateLimit: (detection: RateLimitDetection) => void;
  /** Debounce window (ms) to avoid duplicate detections from multiple signals. */
  debounceMs?: number;
}

export function createRateLimitDetector(options: RateLimitDetectorOptions): () => void {
  const config = PLATFORM_CONFIGS[options.platform];
  const debounceMs = options.debounceMs ?? 3000;
  let lastDetection = 0;
  const cleanups: Array<() => void> = [];

  const emit = (details: Omit<RateLimitDetection, 'platform' | 'timestamp'>): void => {
    const now = Date.now();
    if (now - lastDetection < debounceMs) return; // deduplicate
    lastDetection = now;
    options.onRateLimit({
      ...details,
      platform: options.platform,
      timestamp: new Date().toISOString(),
    });
  };

  // 1. DOM mutation observer
  const domCleanup = watchDOMForRateLimit(
    config.textPatterns,
    config.selectors,
    (matches, node) => {
      const el = node instanceof Element ? node : (node.parentElement ?? document.body);
      const selector = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') +
        (el.className ? '.' + (typeof el.className === 'string' ? el.className.split(' ').join('.') : '') : '');
      emit({
        detected: true,
        source: 'dom',
        message: matches.input ?? matches[0],
        selector,
      });
    },
  );
  cleanups.push(domCleanup);

  // 2. fetch() interception
  const fetchCleanup = instrumentFetch((event) => {
    const matchingApi = config.apiUrlPatterns.some((p) => p.test(event.url));
    if (!matchingApi) return;

    emit({
      detected: true,
      source: 'fetch',
      message: `HTTP 429 on ${event.url}`,
      retryAfterSeconds: event.retryAfter ? parseInt(event.retryAfter, 10) || undefined : undefined,
    });
  });
  cleanups.push(fetchCleanup);

  // 3. XHR interception
  const xhrCleanup = instrumentXHR((event) => {
    const matchingApi = config.apiUrlPatterns.some((p) => p.test(event.url));
    if (!matchingApi) return;

    emit({
      detected: true,
      source: 'xhr',
      message: `HTTP 429 (XHR) on ${event.url}`,
      retryAfterSeconds: event.retryAfter ? parseInt(event.retryAfter, 10) || undefined : undefined,
    });
  });
  cleanups.push(xhrCleanup);

  return () => cleanups.forEach((c) => c());
}

// ---------------------------------------------------------------------------
// 6. RELAY (OSS) DAEMON-MODE RATE-LIMIT DETECTION PATTERNS
// ---------------------------------------------------------------------------

/**
 * The Relay OSS project (https://github.com/relay-ai/relay, formerly
 * nicepkg/gpt-runner) uses a daemon-mode approach for rate-limit detection
 * across multiple AI providers.  Key patterns:
 *
 * 1. RESPONSE-STREAM PARSING
 *    Relay intercepts SSE (Server-Sent Events) streams from AI APIs and
 *    inspects each chunk for error payloads.  Many providers return rate-limit
 *    errors in the stream itself (not just as HTTP status codes).
 *
 *    Example — OpenAI SSE error chunk:
 *      data: {"error":{"message":"Rate limit reached","type":"rate_limit_error","param":null,"code":"rate_limit_exceeded"}}
 *
 *    Example — Anthropic SSE error:
 *      event: error
 *      data: {"type":"error","error":{"type":"rate_limit_error","message":"..."}}
 *
 *    Example — Google Generative Language error:
 *      [{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}]
 *
 * 2. HTTP RESPONSE HEADER INSPECTION
 *    For non-streaming requests, Relay reads the HTTP response status and
 *    the following headers:
 *      - `x-ratelimit-remaining-requests` (OpenAI)
 *      - `x-ratelimit-remaining-tokens` (OpenAI)
 *      - `anthropic-ratelimit-requests-remaining` (Anthropic)
 *      - `anthropic-ratelimit-tokens-remaining` (Anthropic)
 *      - `retry-after` (most providers)
 *      - `x-ratelimit-reset-*` (OpenAI)
 *    When remaining hits zero, Relay proactively pauses before the next
 *    request rather than waiting for a 429.
 *
 * 3. PRE-FLIGHT RATE-LIMIT SELF-CHECK
 *    Before sending a batch of requests, Relay checks the current usage
 *    via provider-specific rate-limit status endpoints:
 *      - OpenAI: reads headers from a lightweight request
 *      - Anthropic: Rate Limits API (`/v1/rate_limits`)
 *      - Google: quota project endpoint
 *
 * 4. DAEMON QUEUE WITH BACKPRESSURE
 *    Relay maintains an in-memory queue. When a 429 is received:
 *      a. The failed request is requeued with exponential-backoff delay.
 *      b. The daemon sets a "rate-limited" flag that pauses the entire
 *         provider queue for `retry-after` seconds.
 *      c. All queued requests for that provider are held until the flag clears.
 *      d. A "slow-start" ramp is applied after each cooldown (start at 1 QPS,
 *         double every successful request up to the normal rate).
 *
 * 5. CROSS-PROVIDER LOAD BALANCING
 *    If one provider is rate-limited, Relay can transparently route queued
 *    requests to an alternative provider that supports the same model
 *    class (e.g., route Claude requests to an OpenAI-compatible proxy if
 *    Anthropic is rate-limited).
 *
 * 6. BROWSER-EXTENSION CONTEXT DIFFERENCES
 *    In a browser extension, we can't run a persistent daemon process,
 *    but we can emulate these patterns using a service worker:
 *      - `chrome.storage.session` is the queue (we already use this!)
 *      - The service worker can hold rate-limit state per provider
 *      - Content scripts report 429 detections to the SW
 *      - The SW can route/stall staging operations accordingly
 */

/**
 * Emulate Relay's rate-limit header preflight check.
 * Returns the number of remaining requests/tokens, or null if unavailable.
 */
export interface RateLimitStatus {
  requestsRemaining: number | null;
  tokensRemaining: number | null;
  resetAt: string | null; // ISO timestamp
}

export function parseOpenAIRateLimitHeaders(headers: Headers): RateLimitStatus {
  return {
    requestsRemaining: parseHeaderInt(headers, 'x-ratelimit-remaining-requests'),
    tokensRemaining: parseHeaderInt(headers, 'x-ratelimit-remaining-tokens'),
    resetAt: parseResetTimestamp(headers, 'x-ratelimit-reset-requests'),
  };
}

export function parseAnthropicRateLimitHeaders(headers: Headers): RateLimitStatus {
  return {
    requestsRemaining: parseHeaderInt(headers, 'anthropic-ratelimit-requests-remaining'),
    tokensRemaining: parseHeaderInt(headers, 'anthropic-ratelimit-tokens-remaining'),
    resetAt: headers.get('anthropic-ratelimit-requests-reset'),
  };
}

function parseHeaderInt(headers: Headers, key: string): number | null {
  const val = headers.get(key);
  if (val === null) return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

function parseResetTimestamp(headers: Headers, key: string): string | null {
  const val = headers.get(key);
  if (!val) return null;

  // OpenAI uses durations like "1s", "6m0s"
  const durMatch = val.match(/^(\d+)(h)?(\d+)?(m)?(\d+)?(s)?/i);
  if (durMatch) {
    const h = parseInt(durMatch[1], 10) || 0;
    const m = parseInt(durMatch[3], 10) || 0;
    const s = parseInt(durMatch[5], 10) || 0;
    const resetDate = new Date(Date.now() + h * 3600_000 + m * 60_000 + s * 1000);
    return resetDate.toISOString();
  }
  // Anthropic uses RFC 3339 timestamps
  return val;
}

// ---------------------------------------------------------------------------
// 7. RATE LIMIT TIER REFERENCE TABLE (as of 2026)
// ---------------------------------------------------------------------------

/**
 * Approximate rate limits for web UIs (NOT APIs) as of May 2026.
 * These are best-effort; platforms frequently adjust tiers.
 */
export const RATE_LIMIT_TIERS = {
  chatgpt: {
    free: {
      messages: '~10 GPT-4o msgs / 3 hours, then fallback to GPT-4o-mini',
      gpt4oMini: 'Unlimited (throttled after heavy use)',
      files: 'Limited file uploads',
      webSearch: 'Limited',
    },
    plus: {
      messages: '~80 GPT-4.1 / 3 hrs; ~40 GPT-4o / 3 hrs',
      gpt4oMini: 'Unlimited',
      files: 'Standard',
      webSearch: 'Standard',
    },
    pro: {
      messages: 'Near-unlimited GPT-5.5, Opus, all models',
    },
  },
  claude: {
    free: {
      messages: '~10-15 msgs per conversation, daily caps; Haiku fallback',
    },
    pro: {
      messages: '~45 msgs / 5 hours on Sonnet 4; unlimited Haiku 3.5',
    },
    max: {
      messages: 'Higher limits on Opus 4, priority access',
    },
  },
  gemini: {
    free: {
      messages: '~50/day Gemini 2.5 Pro; unlimited Flash models',
    },
    aiPremium: {
      messages: 'Significantly higher Pro limits; Ultra/experimental access',
    },
  },
  deepseek: {
    free: {
      messages: '~100 msgs/day all models; generous free tier',
      peakHours: 'Stricter limits during CN daytime (~10AM-6PM CST)',
    },
    api: {
      concurrency: '500 (v4-pro), 2500 (v4-flash)',
    },
  },
  perplexity: {
    free: {
      proSearches: '~5 Pro searches/day',
      quickSearches: 'Unlimited',
    },
    pro: {
      proSearches: '~300-600 Pro searches/day',
      quickSearches: 'Unlimited',
    },
  },
  grok: {
    free: {
      messages: '~10 queries / 2 hours (Grok model)',
    },
    xPremium: {
      messages: '~50 queries / 2 hours',
    },
    xPremiumPlus: {
      messages: 'Higher limits, Grok 4 access',
    },
  },
  kimi: {
    free: {
      messages: '~100 msgs/day',
      files: 'Limited upload size',
    },
  },
  qwen: {
    free: {
      messages: '~100 msgs/day (varies by model)',
    },
  },
  poe: {
    free: {
      messages: '~10 msgs/day (standard models), ~1-3 (premium models)',
      computePoints: 'Limited daily compute budget',
    },
    subscriber: {
      computePoints: '1M compute points/month (varying cost per model)',
    },
  },
  copilot: {
    free: {
      completions: '2000/month',
      chat: '50 msgs/month',
    },
    pro: {
      completions: 'Unlimited',
      chat: '300 msgs/month',
    },
    proPlus: {
      completions: 'Unlimited',
      chat: 'Unlimited (agentic features included)',
    },
  },
} as const;
