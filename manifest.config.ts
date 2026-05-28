import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'CIRA — Context Intelligent Relay Assistant',
  short_name: 'CIRA',
  description:
    'Carry conversation context between ChatGPT, Claude, and Gemini without copy-paste.',
  version: pkg.version,
  action: {
    default_title: 'CIRA',
    default_popup: 'src/popup/index.html',
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: [
        'https://chat.openai.com/*',
        'https://chatgpt.com/*',
      ],
      js: ['src/content/chatgpt.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://claude.ai/*'],
      js: ['src/content/claude.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'tabs', 'scripting'],
  host_permissions: [
    'https://chat.openai.com/*',
    'https://chatgpt.com/*',
    'https://claude.ai/*',
  ],
  icons: {
    '16': 'src/assets/icon-16.png',
    '32': 'src/assets/icon-32.png',
    '48': 'src/assets/icon-48.png',
    '128': 'src/assets/icon-128.png',
  },
});
