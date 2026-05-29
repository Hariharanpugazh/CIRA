import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

const AI_MATCHES = [
  'https://chat.openai.com/*',
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://chat.deepseek.com/*',
  'https://perplexity.ai/*',
  'https://www.perplexity.ai/*',
  'https://copilot.microsoft.com/*',
  'https://grok.com/*',
  'https://x.com/i/grok/*',
  'https://kimi.moonshot.cn/*',
  'https://tongyi.aliyun.com/*',
  'https://chat.qwen.ai/*',
  'https://poe.com/*',
  'https://huggingface.co/chat/*',
  'https://notebooklm.google.com/*',
  'https://you.com/*',
  'https://character.ai/*',
  'https://pi.ai/*',
  'https://z.ai/*',
  'https://chat.mistral.ai/*',
];

export default defineManifest({
  manifest_version: 3,
  name: 'CIRA — Context Intelligent Relay Assistant',
  short_name: 'CIRA',
  description:
    'Carry conversation context between ChatGPT, Claude, Gemini, and 12 other AI platforms.',
  version: pkg.version,
  action: {
    default_title: 'CIRA',
    default_popup: 'src/popup/index.html',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: AI_MATCHES,
      js: ['src/content/universal.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: [
    'storage',
    'tabs',
    'scripting',
    'sidePanel',
    'unlimitedStorage',
    'offscreen',
  ],
  host_permissions: AI_MATCHES,
  icons: {
    '16': 'src/assets/icon-16.png',
    '32': 'src/assets/icon-32.png',
    '48': 'src/assets/icon-48.png',
    '128': 'src/assets/icon-128.png',
  },
});
