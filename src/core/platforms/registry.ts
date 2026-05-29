import type { Source } from '@/core/schema';

export interface PlatformDef {
  id: Source;
  name: string;
  urlPatterns: RegExp[];
  matchScore: (url: string) => number;
  extractors: {
    input: string[];
    userMessages: string[];
    assistantMessages: string[];
    title: string[];
    codeBlocks: string[];
    images: string[];
    codeLanguage: string[];
  };
  injector: {
    inputSelectors: string[];
    type: 'textarea' | 'contenteditable' | 'prosemirror';
  };
  rateLimitIndicators: string[];
  features: {
    hasImages: boolean;
    hasFiles: boolean;
    hasThinking: boolean;
  };
}

function scoreFromPattern(pattern: RegExp, url: string): number {
  if (!pattern.test(url)) return 0;
  const src = pattern.source;
  let score = 10;
  score += src.length * 2;
  if (src.includes('\\/')) score += 5;
  if (src.startsWith('^')) score += 3;
  return score;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    urlPatterns: [/chat\.openai\.com/, /chatgpt\.com/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror', 'textarea[data-id="root"]', 'textarea'],
      userMessages: ['[data-message-author-role="user"]', '[data-message-author-role="system"]', '[role="listbox"] [data-message-id]'],
      assistantMessages: ['[data-message-author-role="assistant"]', '[data-message-author-role="tool"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt="Generated image"]', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]', 'pre[data-language]'],
    },
    injector: {
      inputSelectors: ['#prompt-textarea', 'div[contenteditable="true"].ProseMirror', 'textarea[data-id="root"]', 'textarea'],
      type: 'prosemirror',
    },
    rateLimitIndicators: ['[class*="text-token-text-error"]', '[role="alert"]', '[class*="upsell"]', '#prompt-textarea[disabled]'],
    features: { hasImages: true, hasFiles: true, hasThinking: true },
  },
  {
    id: 'claude',
    name: 'Claude',
    urlPatterns: [/claude\.ai/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
      userMessages: ['[data-testid="user-message"]', '[class*="user-message"]', '[class*="human"]'],
      assistantMessages: ['.font-claude-message', '[class*="assistant-message"]', '[class*="claude"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([role="presentation"])', 'img'],
      codeLanguage: ['code[class*="language-"]', 'pre[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
      type: 'prosemirror',
    },
    rateLimitIndicators: ['.font-claude-message', '[class*="banner"]', '[role="alert"]', 'div[contenteditable="true"][aria-disabled="true"]'],
    features: { hasImages: true, hasFiles: true, hasThinking: true },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    urlPatterns: [/gemini\.google\.com/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['div[contenteditable="true"][role="textbox"]', 'textarea[aria-label*="Enter a prompt"]', 'textarea[aria-label*="prompt"]', 'textarea'],
      userMessages: ['message-content[data-role="user"]', '[data-role="user"]', '.user-query', '[class*="user-query"]', '[class*="user-turn"]'],
      assistantMessages: ['message-content[data-role="model"]', '[data-role="model"]', '.model-response', '[class*="model-response"]', '[class*="model-turn"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['div[contenteditable="true"][role="textbox"]', 'textarea[aria-label*="prompt"]', 'textarea[aria-label*="Enter"]', 'textarea'],
      type: 'contenteditable',
    },
    rateLimitIndicators: ['[class*="error"]', 'md-snackbar', '[class*="snackbar"]', '[class*="banner"]'],
    features: { hasImages: true, hasFiles: true, hasThinking: false },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    urlPatterns: [/chat\.deepseek\.com/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="message"]', 'textarea#chat-input', 'textarea[placeholder*="Send"]', 'textarea'],
      userMessages: ['[class*="user-message"]', '[class*="question"]', '[data-role="user"]', '[class*="chat-item"]:not([class*="assistant"])'],
      assistantMessages: ['.ds-markdown', '[class*="assistant-message"]', '[class*="answer"]', '[data-role="assistant"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([width="16"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="message"]', 'textarea#chat-input', 'textarea[placeholder*="Send"]', 'textarea'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="modal"]', '[class*="dialog"]', '[class*="toast"]', 'textarea[disabled]'],
    features: { hasImages: false, hasFiles: true, hasThinking: true },
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    urlPatterns: [/perplexity\.ai/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="Ask"]', 'textarea[aria-label*="query"]', 'textarea[placeholder*="question"]', 'textarea'],
      userMessages: ['[data-testid*="thread"] [class*="query"]', '[class*="user-query"]', '[data-role="user"]', '[class*="user"]'],
      assistantMessages: ['.prose', '[data-testid*="thread"] [class*="response"]', '[data-role="assistant"]', '[class*="answer"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="Ask"]', 'textarea[aria-label*="query"]', 'textarea[placeholder*="question"]', 'textarea'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="toast"]', '[class*="notification"]', '[role="alert"]', '[class*="upsell"]'],
    features: { hasImages: true, hasFiles: true, hasThinking: true },
  },
  {
    id: 'copilot',
    name: 'Copilot',
    urlPatterns: [/copilot\.microsoft\.com/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea', '#userInput', 'div[contenteditable="true"]', '[role="textbox"]'],
      userMessages: ['[data-testid*="user-message"]', '[class*="user"] [class*="message"]', '[aria-label*="You said"]', '[class*="human"]'],
      assistantMessages: ['[data-testid*="bot-message"]', '[class*="assistant"] [class*="message"]', '[aria-label*="Copilot"]', '[class*="ai"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([role="presentation"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea', '#userInput', 'div[contenteditable="true"]'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="flash"]', '[class*="toast"]', '[role="alert"]'],
    features: { hasImages: true, hasFiles: true, hasThinking: false },
  },
  {
    id: 'grok',
    name: 'Grok',
    urlPatterns: [/grok\.com/, /x\.com\/i\/grok/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="Ask"]', 'div[contenteditable="true"]', 'textarea[placeholder*="message"]', 'textarea'],
      userMessages: ['[data-testid*="user"]', '[class*="user-bubble"]', '[class*="user-message"]', '[data-role="user"]'],
      assistantMessages: ['[data-testid*="assistant"]', '[class*="grok-response"]', '[class*="bot-message"]', '[data-role="assistant"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="Ask"]', 'div[contenteditable="true"]', 'textarea'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="grok"] [class*="error"]', '[class*="toast"]', '[role="alert"]', 'textarea[disabled]'],
    features: { hasImages: true, hasFiles: false, hasThinking: false },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    urlPatterns: [/kimi\.moonshot\.cn/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="message"]', 'textarea[placeholder*="send"]', 'textarea[placeholder*="问题"]', 'textarea'],
      userMessages: ['[class*="user-message"]', '[class*="question"]', '[data-role="user"]', '[class*="human"]'],
      assistantMessages: ['[class*="assistant-message"]', '[class*="answer"]', '[data-role="assistant"]', '[class*="kimi"] [class*="reply"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="message"]', 'textarea[placeholder*="send"]', 'textarea[placeholder*="问题"]', 'textarea'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="modal"]', '[class*="dialog"]', '[class*="toast"]', '[class*="error"]', 'textarea[disabled]'],
    features: { hasImages: false, hasFiles: true, hasThinking: false },
  },
  {
    id: 'qwen',
    name: 'Qwen',
    urlPatterns: [/tongyi\.aliyun\.com/, /chat\.qwen\.ai/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="question"]', 'textarea[placeholder*="问题"]', 'textarea[placeholder*="message"]', 'textarea'],
      userMessages: ['[class*="user-message"]', '[class*="question-item"]', '[data-role="user"]', '[class*="human"]'],
      assistantMessages: ['[class*="assistant-message"]', '[class*="answer-item"]', '[data-role="assistant"]', '[class*="tongyi"] [class*="reply"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="question"]', 'textarea[placeholder*="问题"]', 'textarea[placeholder*="message"]', 'textarea'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="toast"]', '[class*="notification"]', '[class*="modal"]', '[class*="error"]', 'textarea[disabled]'],
    features: { hasImages: true, hasFiles: true, hasThinking: false },
  },
  {
    id: 'poe',
    name: 'Poe',
    urlPatterns: [/poe\.com/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="message"]', 'textarea[placeholder*="Send"]', 'textarea[placeholder*="chat"]', 'textarea'],
      userMessages: ['.Message_message__', '[class*="message"][class*="human"]', '[data-role="user"]', '[class*="user"] [class*="message"]'],
      assistantMessages: ['.ChatMessage_', '[class*="bot"] [class*="message"]', '[data-role="assistant"]', '[class*="chatbot"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="message"]', 'textarea[placeholder*="Send"]', 'textarea'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="toast"]', '[class*="overlay"]', '[class*="upsell"]', 'textarea[disabled]'],
    features: { hasImages: true, hasFiles: true, hasThinking: false },
  },
  {
    id: 'huggingchat',
    name: 'HuggingChat',
    urlPatterns: [/huggingface\.co\/chat/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="message"]', 'textarea[placeholder*="Ask"]', 'textarea[placeholder*="chat"]', 'textarea'],
      userMessages: ['[class*="user-message"]', '[class*="message"] [class*="user"]', '[data-role="user"]', '[class*="human"]'],
      assistantMessages: ['[class*="assistant-message"]', '[class*="message"] [class*="bot"]', '[data-role="assistant"]', '[class*="ai"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="message"]', 'textarea[placeholder*="Ask"]', 'textarea'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="error"]', '[class*="toast"]', '[role="alert"]'],
    features: { hasImages: false, hasFiles: true, hasThinking: false },
  },
  {
    id: 'notebooklm',
    name: 'NotebookLM',
    urlPatterns: [/notebooklm\.google\.com/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="Ask"]', 'textarea[placeholder*="question"]', 'textarea', 'div[contenteditable="true"]'],
      userMessages: ['[class*="user-message"]', '[class*="question"]', '[data-role="user"]', '[class*="user"]'],
      assistantMessages: ['[class*="assistant-message"]', '[class*="answer"]', '[data-role="assistant"]', '[class*="response"]'],
      title: ['title'],
      codeBlocks: ['pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="Ask"]', 'textarea', 'div[contenteditable="true"]'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="error"]', '[class*="banner"]'],
    features: { hasImages: false, hasFiles: true, hasThinking: false },
  },
  {
    id: 'you',
    name: 'You.com',
    urlPatterns: [/you\.com/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="Ask"]', 'textarea[placeholder*="message"]', 'textarea', '#search-input'],
      userMessages: ['[class*="user-message"]', '[class*="query"]', '[data-role="user"]'],
      assistantMessages: ['[class*="assistant-message"]', '[class*="response"]', '[data-role="assistant"]', '[class*="answer"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="Ask"]', 'textarea', '#search-input'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="error"]', '[class*="banner"]', '[role="alert"]'],
    features: { hasImages: true, hasFiles: false, hasThinking: false },
  },
  {
    id: 'characterai',
    name: 'Character.AI',
    urlPatterns: [/character\.ai/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="message"]', 'textarea[placeholder*="Type"]', 'textarea', 'div[contenteditable="true"]'],
      userMessages: ['[class*="user-message"]', '[class*="user-bubble"]', '[data-role="user"]', '[class*="human"]'],
      assistantMessages: ['[class*="character-message"]', '[class*="bot-message"]', '[class*="assistant"]', '[data-role="assistant"]'],
      title: ['title'],
      codeBlocks: ['pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="message"]', 'textarea[placeholder*="Type"]', 'textarea', 'div[contenteditable="true"]'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="error"]', '[class*="banner"]', '[role="alert"]'],
    features: { hasImages: true, hasFiles: false, hasThinking: false },
  },
  {
    id: 'pi',
    name: 'Pi',
    urlPatterns: [/pi\.ai/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="message"]', 'textarea', 'input[type="text"]'],
      userMessages: ['[class*="user-message"]', '[class*="query"]', '[data-role="user"]'],
      assistantMessages: ['[class*="assistant-message"]', '[class*="pi-response"]', '[data-role="assistant"]', '[class*="bot"]'],
      title: ['title'],
      codeBlocks: ['pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img:not([aria-hidden="true"])', 'img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea[placeholder*="message"]', 'textarea', 'input[type="text"]'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="error"]', '[role="alert"]'],
    features: { hasImages: false, hasFiles: false, hasThinking: false },
  },
  {
    id: 'zai',
    name: 'Z.ai',
    urlPatterns: [/z\.ai/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="message"]', 'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'],
      userMessages: ['[data-role="user"]', '[class*="user-message"]', '[class*="message"][class*="human"]'],
      assistantMessages: ['[data-role="assistant"]', '[class*="ai-message"]', '[class*="message"][class*="bot"]', '[class*="assistant"]'],
      title: ['title'],
      codeBlocks: ['pre code', 'pre'],
      images: ['img', 'img[alt]'],
      codeLanguage: ['code[class*="language-"]', 'pre[class*="language-"]'],
    },
    injector: {
      type: 'textarea',
      inputSelectors: ['textarea[placeholder*="message"]', 'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'],
    },
    rateLimitIndicators: ['[class*="rate-limit"]', '[class*="error"]', '[class*="toast"]', '[role="alert"]'],
    features: { hasImages: false, hasFiles: false, hasThinking: false },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    urlPatterns: [/chat\.mistral\.ai/, /mistral\.ai/],
    matchScore(url: string) {
      return Math.max(...this.urlPatterns.map((p) => scoreFromPattern(p, url)));
    },
    extractors: {
      input: ['textarea[placeholder*="Ask"]', 'textarea', 'div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
      userMessages: ['[data-role="user"]', '[data-message-author-role="user"]', '[class*="user-message"]', '[class*="message-user"]'],
      assistantMessages: ['[data-role="assistant"]', '[data-message-author-role="assistant"]', '[class*="assistant-message"]', '[class*="message-assistant"]'],
      title: ['title'],
      codeBlocks: ['pre code[class*="language-"]', 'pre code', 'pre'],
      images: ['img[alt]:not([alt=""])', 'img'],
      codeLanguage: ['code[class*="language-"]', 'pre[class*="language-"]'],
    },
    injector: {
      type: 'textarea',
      inputSelectors: ['textarea[placeholder*="Ask"]', 'textarea', 'div[contenteditable="true"]'],
    },
    rateLimitIndicators: ['[class*="rate-limit"]', '[class*="limit"]', '[class*="error-banner"]', '[role="alert"]'],
    features: { hasImages: false, hasFiles: true, hasThinking: false },
  },
  {
    id: 'unknown',
    name: 'Unknown Platform',
    urlPatterns: [/.*/],
    matchScore() {
      return 1;
    },
    extractors: {
      input: ['textarea', 'div[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'],
      userMessages: ['[data-role="user"]', '[class*="user"]', '[class*="human"]', '[class*="question"]'],
      assistantMessages: ['[data-role="assistant"]', '[class*="assistant"]', '[class*="bot"]', '[class*="ai"]', '[class*="response"]', '[class*="answer"]'],
      title: ['title'],
      codeBlocks: ['pre code', 'pre'],
      images: ['img'],
      codeLanguage: ['code[class*="language-"]'],
    },
    injector: {
      inputSelectors: ['textarea', 'div[contenteditable="true"]', '[role="textbox"]', 'input[type="text"]'],
      type: 'textarea',
    },
    rateLimitIndicators: ['[class*="error"]', '[role="alert"]'],
    features: { hasImages: false, hasFiles: false, hasThinking: false },
  },
];

export function getPlatformId(): Source {
  const url = location.href;
  let best: PlatformDef | null = null;
  let bestScore = 0;
  for (const p of PLATFORMS) {
    if (p.id === 'unknown') continue;
    const score = p.matchScore(url);
    if (score > 0 && score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best?.id ?? 'unknown';
}

export function getPlatformDef(id: string): PlatformDef | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

export function getPlatformDefForUrl(url: string): PlatformDef {
  let best: PlatformDef | null = null;
  let bestScore = 0;
  for (const p of PLATFORMS) {
    if (p.id === 'unknown') continue;
    const score = p.matchScore(url);
    if (score > 0 && score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best ?? PLATFORMS[PLATFORMS.length - 1];
}

export function getAllPlatforms(): PlatformDef[] {
  return PLATFORMS.filter((p) => p.id !== 'unknown');
}
