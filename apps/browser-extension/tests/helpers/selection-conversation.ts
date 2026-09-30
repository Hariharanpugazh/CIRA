import type { Conversation } from '@/shared/schema';

/** Six messages, each with distinct extractable context, so selections are easy to verify. */
export function selectionConversation(): Conversation {
  return {
    source: 'chatgpt',
    title: 'TypeScript React Django Stack',
    url: 'https://chatgpt.com/c/7f3e2a10-5b4c-4d8e-9a61-0c2b3d4e5f60',
    capturedAt: '2026-09-30T10:00:00.000Z',
    messages: [
      { role: 'user', content: "I'm building a TypeScript project. I prefer React and Tailwind." },
      { role: 'assistant', content: "We'll use Django for the backend.\n\n```text\nproject/\n├── frontend/\n└── backend/\n```" },
      { role: 'user', content: 'The project needs authentication. Do not use Firebase.' },
      { role: 'assistant', content: 'Here is the login call:\n\n```ts\nconst token = await login(user, password);\n```' },
      { role: 'user', content: 'Can you also add rate limiting?' },
      { role: 'assistant', content: "We'll use Redis for rate limits." },
    ],
  };
}
