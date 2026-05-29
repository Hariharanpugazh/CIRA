import { db, type ConversationRecord } from '@/core/db';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMarkdown(conv: ConversationRecord, includeMetadata = true): string {
  const lines: string[] = [];

  if (includeMetadata) {
    lines.push(
      `# ${conv.title}`,
      `**Source:** ${conv.platform} | **URL:** ${conv.url}`,
      `**Captured:** ${conv.capturedAt} | **Messages:** ${conv.messageCount}`,
      '',
    );
  }

  for (const msg of conv.messages) {
    const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    lines.push(`### ${roleLabel}`, '');

    if (msg.codeBlocks && msg.codeBlocks.length > 0) {
      const contentWithoutCode = msg.content.replace(/```[\s\S]*?```/g, '').trim();
      if (contentWithoutCode) lines.push(contentWithoutCode, '');
      for (const block of msg.codeBlocks) {
        lines.push('```' + (block.language || '') + '\n' + block.code + '\n```', '');
      }
    } else {
      lines.push(msg.content, '');
    }
  }

  return lines.join('\n');
}

function formatHtml(conv: ConversationRecord): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(conv.title)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e1e4e8; line-height: 1.6; }
.container { max-width: 840px; margin: 0 auto; padding: 32px 24px; }
.header { border-bottom: 1px solid #30363d; padding-bottom: 16px; margin-bottom: 32px; }
.header h1 { font-size: 1.5rem; margin-bottom: 8px; }
.meta { font-size: 0.8rem; color: #8b949e; }
.meta span { margin-right: 16px; }
.message { margin-bottom: 24px; padding: 16px; border-radius: 8px; }
.message.user { background: #1a2332; border: 1px solid #1f6feb; }
.message.assistant { background: #151b23; border: 1px solid #30363d; }
.message.system { background: #1c1917; border: 1px solid #d29922; }
.role { font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
.role.user { color: #58a6ff; }
.role.assistant { color: #7ee787; }
.role.system { color: #d29922; }
.content { font-size: 0.9rem; white-space: pre-wrap; word-break: break-word; }
.content code { background: #1c2128; padding: 2px 6px; border-radius: 3px; font-size: 0.85em; }
.content pre { background: #161b22; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
.content pre code { background: none; padding: 0; }
.label { display: inline-block; font-size: 0.65rem; padding: 2px 6px; border-radius: 3px; margin-right: 4px; }
.label.user { background: #1f6feb33; color: #58a6ff; }
.label.assistant { background: #23863633; color: #7ee787; }
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>${escapeHtml(conv.title)}</h1>
<div class="meta">
<span>Platform: ${escapeHtml(conv.platform)}</span>
<span>Captured: ${escapeHtml(conv.capturedAt)}</span>
<span>Messages: ${conv.messageCount}</span>
</div>
</div>
`;
  for (const msg of conv.messages) {
    html += `<div class="message ${msg.role}">
<div class="role ${msg.role}"><span class="label ${msg.role}">${msg.role}</span></div>
<div class="content">`;

    if (msg.codeBlocks && msg.codeBlocks.length > 0) {
      const contentWithoutCode = msg.content.replace(/```[\s\S]*?```/g, '').trim();
      if (contentWithoutCode) html += escapeHtml(contentWithoutCode) + '\n';
      for (const block of msg.codeBlocks) {
        html += `<pre><code class="language-${block.language}">${escapeHtml(block.code)}</code></pre>\n`;
      }
    } else {
      html += escapeHtml(msg.content);
    }

    html += '</div>\n</div>\n';
  }

  html += '</div>\n</body>\n</html>';
  return html;
}

export async function exportConversation(
  id: number,
  format: 'json' | 'md' | 'html',
): Promise<Blob> {
  const conv = await db.conversations.get(id);
  if (!conv) throw new Error(`Conversation ${id} not found`);

  switch (format) {
    case 'json':
      return new Blob([JSON.stringify(conv, null, 2)], { type: 'application/json' });
    case 'md':
      return new Blob([formatMarkdown(conv)], { type: 'text/markdown' });
    case 'html':
      return new Blob([formatHtml(conv)], { type: 'text/html' });
  }
}

export async function exportBundle(
  ids: number[],
  format: 'json' | 'md',
): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();

  const conversations = await db.conversations.bulkGet(ids);

  for (const conv of conversations) {
    if (!conv) continue;
    const safeFilename = (conv.title || `conversation-${conv.id}`)
      .replace(/[^a-z0-9_-]/gi, '_')
      .slice(0, 80);

    switch (format) {
      case 'json': {
        zip.file(`${safeFilename}.json`, JSON.stringify(conv, null, 2));
        break;
      }
      case 'md': {
        zip.file(`${safeFilename}.md`, formatMarkdown(conv));
        break;
      }
    }
  }

  const manifest = {
    exportedAt: new Date().toISOString(),
    format,
    conversationCount: conversations.filter(Boolean).length,
    ids,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  return blob;
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const reader = new FileReader();
  const dataUrl = await new Promise<string>((resolve) => {
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,
  });
}
