/**
 * Multi-Modal Media Extraction Utilities
 * =======================================
 * Research-backed techniques for extracting images, files, tables, LaTeX,
 * and other rich content from AI chat platform DOMs (ChatGPT, Claude, Gemini).
 *
 * Key principle: These platforms change their DOM frequently. Every extraction
 * uses cascading selectors — try the most specific, fall back to broad heuristics.
 *
 * Chrome Extension context notes:
 *   - Content scripts run in the page's JS context but with chrome.* API access.
 *   - Blob URLs from the host page ARE accessible because content scripts share
 *     the page's origin (no CORS issue for same-origin Blobs).
 *   - Cross-origin images (e.g., filesystem: URLs in Claude) require the offscreen
 *     document or background service worker to fetch via `fetch()`.
 *   - chrome.storage.session limit is 10 MB. Large bundles (with images) should
 *     use IndexedDB in the service worker, or split payloads.
 */

/* ------------------------------------------------------------------ */
/*  1. IMAGE EXTRACTION FROM CHAT                                       */
/* ------------------------------------------------------------------ */

export interface ExtractedImage {
  /** Best-effort alt text / aria-label / caption — can be empty. */
  alt: string;
  /** Data URL form (safe to embed in HTML/Markdown). */
  dataUrl: string;
  /** Original MIME type. */
  mimeType: string;
  /** Width × Height in pixels (if inferrable). */
  width?: number;
  height?: number;
  /** The selector strategy that matched (for debugging). */
  source: string;
}

/**
 * Convert a Blob to a base64 data URL. Content scripts can do this directly
 * for same-origin blobs. For cross-origin images, see `fetchImageAsDataUrl`.
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Fetch an image at `url` and return a data URL.
 * Works cross-origin from a content script IF the server sends CORS headers
 * (most CDN-hosted images do). Falls back to a service-worker-side fetch
 * for URLs that don't (e.g., `filesystem:` in Claude, or some blob: URLs).
 *
 * CRITICAL: `fetch` in a content script runs with the page's origin, so
 * most images will work. The edge cases are:
 *   - `filesystem:` protocol (Claude artifacts) → requires offscreen document
 *   - `blob:` created by another frame → same-origin but opaque; use canvas
 *   - SVG with external references → best-effort, may lose external resources
 */
export async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blobToDataUrl(blob);
  } catch {
    // CORS blocked — try via background service worker
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'CIRA/FETCH_IMAGE', url },
        (response: { type: string; dataUrl: string | null } | undefined) => {
          if (response?.type === 'CIRA/FETCH_IMAGE_RESPONSE') {
            resolve(response.dataUrl);
          } else {
            resolve(null);
          }
        },
      );
    });
  }
}

/**
 * Convert a Blob URL to a data URL using fetch.
 * Unlike blobToDataUrl which requires an actual Blob object, this works
 * when you only have the URL string (the common case in chat platforms).
 */
export async function blobUrlToDataUrl(blobUrl: string): Promise<string | null> {
  return fetchImageAsDataUrl(blobUrl);
}

/**
 * Extract an image from an <img> element.
 * Handles real src, srcset, data-src (lazy loading), and DALL-E placeholders.
 */
export async function extractImageFromImg(
  img: HTMLImageElement,
): Promise<ExtractedImage | null> {
  // Resolve the best available src.
  const src =
    img.currentSrc || // picks up srcset / responsive
    img.src ||
    img.getAttribute('data-src') ||
    '';

  if (!src || src.startsWith('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0i')) {
    // Skip placeholder SVGs (common GPT loading spinner pattern).
    return null;
  }

  // If it's already a data URL, use it directly.
  if (src.startsWith('data:')) {
    const mime = src.match(/^data:([^;]+)/)?.[1] ?? 'image/png';
    return {
      alt: img.alt || img.getAttribute('aria-label') || '',
      dataUrl: src,
      mimeType: mime,
      width: img.naturalWidth || undefined,
      height: img.naturalHeight || undefined,
      source: 'img[src^=data:]',
    };
  }

  // blob: or https: — fetch and convert.
  const dataUrl = await fetchImageAsDataUrl(src);
  if (!dataUrl) return null;

  return {
    alt: img.alt || img.getAttribute('aria-label') || '',
    dataUrl,
    mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] ?? 'image/png',
    width: img.naturalWidth || undefined,
    height: img.naturalHeight || undefined,
    source: `img[src=${src.slice(0, 30)}]`,
  };
}

/* ------------------------------------------------------------------ */
/*  ChatGPT-specific: DALL-E generated images                          */
/* ------------------------------------------------------------------ */

/**
 * ChatGPT DALL-E images appear as <img> inside assistant turns.
 * Common wrapper patterns (as of mid-2025):
 *   - <img alt="Generated image" src="https://..." />
 *   - <div class="image-gen-wrapper"> containing the <img>
 *   - <img> inside a role="img" container (GPT-4o vision output)
 *
 * GPT also generates PNG files that users can download — those appear as
 * <a download="..."> links inside the assistant turn.
 */
export function findGeneratedImages(container: Element): HTMLImageElement[] {
  const imgs: HTMLImageElement[] = [];

  // Direct <img> children.
  container.querySelectorAll('img').forEach((img) => {
    // Filter out UI icons (small, inline, or SVG).
    if (
      img.naturalWidth < 50 ||
      img.naturalHeight < 50 ||
      img.src.includes('favicon') ||
      img.src.includes('icon') ||
      img.closest('nav, header, [role="navigation"]')
    ) {
      return;
    }
    imgs.push(img as HTMLImageElement);
  });

  // Generated image wrappers (DALL-E 3).
  container.querySelectorAll('[class*="image-gen"], [class*="dalle"], [role="img"]').forEach((el) => {
    el.querySelectorAll('img').forEach((img) => imgs.push(img as HTMLImageElement));
  });

  return imgs;
}

/**
 * Claude "artifact" content windows are <iframe>-isolated React apps.
 * We CANNOT directly access their DOM from a content script (cross-origin iframe).
 *
 * Strategy:
 *   1. Detect the artifact-iframe by looking for `iframe[src^="https://claude.ai/artifact/"]`
 *   2. The iframe's inner document is same-origin (same domain), BUT it's an isolated React
 *      subtree that Claude controls. We can try `iframe.contentDocument`.
 *   3. Fallback: screenshot the artifact via `html2canvas` injected into the iframe.
 *   4. Sanest approach: capture the artifact's **source code** (Claude shows the code
 *      in a tab alongside the preview). Extract that instead — it's text.
 */

export function findClaudeArtifacts(): HTMLIFrameElement[] {
  return Array.from(
    document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="/artifact/"], iframe[data-artifact]',
    ),
  );
}

/**
 * Attempt to get an artifact iframe's inner document.
 * Returns null if blocked by same-origin policy or CSP.
 */
export function accessArtifactDocument(
  iframe: HTMLIFrameElement,
): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}

/**
 * For Claude artifact windows the most reliable extraction is the source code tab.
 * Claude renders the artifact source in a <pre><code> block visible in the UI.
 * Look for the "Code" tab content which is sibling to the "Preview" tab.
 *
 * Selectors (as of Claude's 2024-2025 UI):
 *   - `div[data-testid="artifact-code"] pre`
 *   - `.artifact-code-panel pre`
 *   - Content inside `[class*="artifact"]` that isn't an iframe
 */
export function extractArtifactSourceCode(container: Element): string | null {
  // Claude shows code in a pre element within the artifact panel.
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    // Skip empty or the main conversation's code blocks — artifact code
    // is usually inside a panel div with class containing 'artifact'.
    const code = pre.textContent ?? '';
    if (code.length > 20 && pre.closest('[class*="artifact"]')) {
      return code;
    }
  }

  // Fallback: look for any large <code> block inside an artifact wrapper.
  const artifactWrapper = container.querySelector(
    '[class*="artifact"], [data-testid*="artifact"]',
  );
  if (artifactWrapper) {
    const codeEl = artifactWrapper.querySelector('code');
    if (codeEl && (codeEl.textContent?.length ?? 0) > 20) {
      return codeEl.textContent!;
    }
    // Last resort: text content of the artifact panel (will include UI chrome too).
    return artifactWrapper.textContent?.trim() ?? null;
  }

  return null;
}

/**
 * Screenshot a DOM node via canvas (for artifacts we can access).
 * Requires html2canvas or a similar library — but for Chrome extensions we can
 * use the native approach below to avoid bundling a heavy dep.
 *
 * LIMITATION: Cross-origin images inside the node will taint the canvas
 * and prevent toDataURL. For Claude artifacts this is fine (they're code).
 */
export function screenshotNode(node: HTMLElement): Promise<string | null> {
  // Use Range + fragment + SVG foreignObject approach (works without html2canvas).
  // This is more reliable in extensions than html2canvas cross-origin handling.
  return new Promise((resolve) => {
    try {
      const clone = node.cloneNode(true) as HTMLElement;
      const width = node.offsetWidth;
      const height = node.offsetHeight;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

      const foreign = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'foreignObject',
      );
      foreign.setAttribute('width', '100%');
      foreign.setAttribute('height', '100%');
      foreign.appendChild(clone);
      svg.appendChild(foreign);

      const serialized = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(null);
      img.src =
        'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialized);
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  2. FILE / ATTACHMENT EXTRACTION                                    */
/* ------------------------------------------------------------------ */

export interface ExtractedFile {
  name: string;
  /** MIME type or extension-based guess. */
  mimeType: string;
  /** File size in bytes (if displayed in UI). */
  size?: number;
  /**
   * For small files (<5MB), a data URL of the file content.
   * For large files, this is null and only metadata is captured.
   */
  dataUrl: string | null;
  /**
   * If the chat UI shows a preview (CSV table, PDF embed, image thumbnail),
   * this captures the text representation.
   */
  preview: string | null;
}

/**
 * ChatGPT file attachments appear as:
 *   - Small "chips" inside the user message: `div[class*="attachment"]` or similar
 *   - Download links: <a> with file name, often wrapping an icon
 *   - For images: <img> inside the user-turn container with filename in alt/aria
 *
 * Claude attachments:
 *   - File chips with document icon, filename, and optional preview expand
 *   - PDFs get rendered as iframes or embedded text extracts
 *   - CSVs get table previews
 */
export function findFileElements(container: Element): HTMLElement[] {
  const selectors = [
    '[class*="attachment"]',
    '[class*="file-chip"]',
    '[class*="uploaded-file"]',
    '[data-testid="file-attachment"]',
    'a[download]',
    '[aria-label*="file"]',
    '[aria-label*="attachment"]',
  ];

  const found = new Set<HTMLElement>();
  for (const sel of selectors) {
    container.querySelectorAll(sel).forEach((el) => {
      found.add(el as HTMLElement);
    });
  }
  return Array.from(found);
}

/**
 * Extract file metadata from a file element.
 * Does NOT download the file — just captures what's visible in the UI.
 */
export function extractFileInfo(
  el: HTMLElement,
): Pick<ExtractedFile, 'name' | 'mimeType' | 'size' | 'preview'> {
  const name =
    el.getAttribute('data-filename') ??
    el.getAttribute('aria-label') ??
    el.querySelector<HTMLAnchorElement>('a[download]')?.download ??
    el.querySelector('[class*="filename"]')?.textContent?.trim() ??
    el.textContent?.trim().slice(0, 100) ??
    'unknown';

  const mimeType =
    guessMimeType(name) ??
    el.getAttribute('data-mime') ??
    el.getAttribute('data-type') ??
    'application/octet-stream';

  const sizeText =
    el.getAttribute('data-size') ??
    el.querySelector('[class*="size"]')?.textContent?.trim();
  const size = sizeText ? parseHumanSize(sizeText) : undefined;

  // Detect file previews
  let preview: string | null = null;

  // CSV tables: look for an inner <table> that was rendered as a preview.
  const table = el.querySelector('table');
  if (table) {
    preview = htmlTableToMarkdown(table);
  }

  // PDF embeds: look for text extracted from the PDF shown inline.
  const pdfTextEl = el.querySelector('[class*="pdf-preview"], [class*="file-content"]');
  if (pdfTextEl) {
    preview = cleanInnerText(pdfTextEl as HTMLElement);
  }

  return { name, mimeType, size, preview };
}

/**
 * Guess MIME type from a filename extension.
 */
function guessMimeType(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  const map: Record<string, string> = {
    csv: 'text/csv',
    json: 'application/json',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    xml: 'text/xml',
    zip: 'application/zip',
    py: 'text/x-python',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    js: 'text/javascript',
    jsx: 'text/javascript',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    toml: 'text/toml',
    sql: 'text/x-sql',
  };
  return map[ext] ?? null;
}

/**
 * Parse human-readable file size like "2.3 MB" → 2300000.
 */
function parseHumanSize(s: string): number | undefined {
  const match = s.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
  };
  return Math.round(num * (multipliers[unit] ?? 1));
}

/**
 * Download a file attachment via fetch and return as data URL.
 * This works for public/signed URLs shown in the chat. For files uploaded
 * by the user, the URL is typically on the platform's CDN with auth cookies
 * (content scripts share cookies, so fetch usually works).
 *
 * CAP: Pass a maxBytes to avoid loading huge files into memory.
 */
export async function fetchFileContent(
  url: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<{ dataUrl: string; mime: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
    if (contentLength > maxBytes) return null;

    const blob = await res.blob();
    if (blob.size > maxBytes) return null;

    const dataUrl = await blobToDataUrl(blob);
    const mime = blob.type || 'application/octet-stream';
    return { dataUrl, mime };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  3. CODE BLOCK PRESERVATION                                         */
/* ------------------------------------------------------------------ */

/**
 * Extract code blocks with language annotations, stripping UI chrome.
 *
 * AI platforms render code in many ways:
 *   ChatGPT:  <pre class="!overflow-visible"><div class="..."><code class="language-py">...</code></div></pre>
 *   Claude:   <pre><code class="language-python">...</code></pre> (with copy button as sibling)
 *   Gemini:   <pre><code class="language-python">...</code></pre>
 *
 * All share the pattern: <pre> wrapping a <code> with optional language-* class.
 */
export function extractCodeBlocks(container: Element): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const seen = new Set<string>();

  container.querySelectorAll('pre').forEach((pre) => {
    // Skip inside artifact panels — we handle those separately.
    if (pre.closest('[class*="artifact"]') && container.closest('[class*="artifact"]') === null) {
      return;
    }

    const codeEl = pre.querySelector('code');
    const code = codeEl?.textContent ?? pre.textContent ?? '';

    // Deduplicate: same code body = same block.
    const key = code.slice(0, 200).trim();
    if (key.length < 3 || seen.has(key)) return;
    seen.add(key);

    // Extract language from:
    //   1. <code class="language-python">
    //   2. <pre data-language="python">
    //   3. Header text like "python" in a sibling div
    //   4. data-code-language attribute
    let lang =
      codeEl?.className.match(/\blanguage-([\w+-]+)\b/)?.[1] ??
      codeEl?.getAttribute('data-language') ??
      pre.getAttribute('data-language') ??
      '';

    // Claude sometimes puts the language in a sibling button or span.
    if (!lang) {
      const langBtn = pre.parentElement?.querySelector(
        'button, [class*="language"], [class*="lang"]',
      );
      const btnText = langBtn?.textContent?.trim().toLowerCase();
      if (btnText && /^[a-z+#]+$/i.test(btnText) && btnText.length < 20) {
        lang = btnText;
      }
    }

    blocks.push({ language: lang, code: code.trim() });
  });

  return blocks;
}

/**
 * Extract inline code spans (`backtick` renders).
 * These are typically just <code> elements NOT inside a <pre>.
 */
export function extractInlineCode(container: Element): string[] {
  const spans: string[] = [];
  container.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre')) return; // skip code blocks
    const text = code.textContent?.trim();
    if (text && text.length < 200) {
      spans.push(text);
    }
  });
  return spans;
}

/**
 * Clean text while preserving code block markers.
 * Strips copy button text, line numbers, and other UI chrome.
 */
export function cleanMessageText(element: Element): string {
  // Pre-process: mark code blocks so we don't strip them.
  element.querySelectorAll('pre').forEach((pre, i) => {
    pre.setAttribute('data-cira-preserve', String(i));
  });

  // Remove known UI-only elements:
  //   - Copy buttons (often <button> with copy SVG)
  //   - Code block headers with language name + copy button
  //   - Line numbers (found in some code renderers)
  const removals = [
    'button[aria-label*="opy"]', // "Copy", "Copy code"
    'button[class*="copy"]',
    '[class*="code-block-header"]',
    '[class*="line-numbers"]',
    '.copy-button',
    '.copy-code-button',
  ];

  for (const sel of removals) {
    element.querySelectorAll(sel).forEach((el) => el.remove());
  }

  // Strip line numbers that are inline spans (GitHub-style rendering).
  element.querySelectorAll('[data-line-number], .line-number, .linenumber').forEach((el) => {
    el.remove();
  });

  const text = cleanInnerText(element as HTMLElement);
  return text;
}

/* ------------------------------------------------------------------ */
/*  4. TABLE EXTRACTION                                                */
/* ------------------------------------------------------------------ */

/**
 * Convert an HTML <table> to a Markdown table.
 *
 * ChatGPT renders tables as responsive HTML tables, sometimes nested in
 * scroll containers. Claude renders them as standard <table> elements.
 *
 * Key challenges:
 *   - Colspan/rowspan merge cells — we expand them
 *   - Multi-line cell content — collapsed to single line
 *   - Nested tables — flattened
 *   - Empty cells — preserved as empty string
 */
export function htmlTableToMarkdown(table: HTMLTableElement): string {
  const rows = table.querySelectorAll('tr');
  if (rows.length === 0) return '';

  const data: string[][] = [];
  const colSpans: Map<string, { value: string; remaining: number }> = new Map();

  rows.forEach((row, rowIdx) => {
    const cells = row.querySelectorAll('th, td');
    const rowData: string[] = [];
    let colIdx = 0;

    cells.forEach((cell) => {
      // Handle rowspan from previous rows.
      while (colSpans.has(`${rowIdx}-${colIdx}`)) {
        const span = colSpans.get(`${rowIdx}-${colIdx}`)!;
        rowData.push(span.value);
        span.remaining--;
        if (span.remaining <= 0) colSpans.delete(`${rowIdx}-${colIdx}`);
        colIdx++;
      }

      const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
      const value = escapeMdTableCell(text);

      const colspan = parseInt(cell.getAttribute('colspan') ?? '1', 10);
      const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10);

      for (let c = 0; c < colspan; c++) {
        rowData.push(value);
        if (rowspan > 1 && c === 0) {
          for (let r = 1; r < rowspan; r++) {
            colSpans.set(`${rowIdx + r}-${colIdx}`, { value, remaining: colspan });
          }
        }
        colIdx++;
      }
    });

    if (rowData.length > 0) data.push(rowData);
  });

  if (data.length === 0) return '';

  // Normalize column count.
  const maxCols = Math.max(...data.map((r) => r.length));
  const normalized = data.map((r) => [...r, ...Array(maxCols - r.length).fill('')]);

  return renderMdTable(normalized);
}

function escapeMdTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderMdTable(rows: string[][]): string {
  if (rows.length === 0) return '';

  const header = rows[0];
  const body = rows.length > 1 ? rows.slice(1) : [];

  const out: string[] = [];
  out.push('| ' + header.join(' | ') + ' |');
  out.push('| ' + header.map(() => '---').join(' | ') + ' |');

  for (const row of body) {
    out.push('| ' + row.join(' | ') + ' |');
  }

  return out.join('\n');
}

/**
 * Find all tables in a container and convert them.
 */
export function extractTables(container: Element): string[] {
  return Array.from(container.querySelectorAll('table')).map((table) =>
    htmlTableToMarkdown(table),
  );
}

/* ------------------------------------------------------------------ */
/*  5. LATEX / MATH EXTRACTION                                         */
/* ------------------------------------------------------------------ */

/**
 * AI platforms render math in several ways:
 *
 *   ChatGPT / Claude (KaTeX approach):
 *     Inline:   <span class="katex">...</span> with nested spans for each symbol
 *     Block:    <span class="katex-display">...</span>
 *     Source:   <annotation encoding="application/x-tex">E = mc^2</annotation>
 *               (present inside the KaTeX HTML — this is our gold source)
 *
 *   Claude (older versions):
 *     Sometimes uses \\(...\\) and \\[...\\] delimiters directly in text.
 *
 *   Gemini:
 *     Uses KaTeX with the same <annotation> pattern, or raw LaTeX in text.
 *
 * Strategy:
 *   1. Look for <annotation encoding="application/x-tex"> inside KaTeX elements.
 *   2. If not found, reconstruct from the KaTeX DOM (fragile, fallback only).
 *   3. Also scan for \(...\) and \[...\] patterns in text nodes.
 */

export interface MathBlock {
  display: boolean; // true = block ($$...$$), false = inline ($...$)
  latex: string;
}

/**
 * Extract LaTeX from KaTeX-rendered elements.
 * KaTeX embeds the original LaTeX source in an <annotation> child.
 */
export function extractKatexMath(container: Element): MathBlock[] {
  const blocks: MathBlock[] = [];

  container.querySelectorAll('.katex').forEach((el) => {
    // The gold source: <annotation encoding="application/x-tex">
    const annotation = el.querySelector(
      'annotation[encoding="application/x-tex"]',
    );
    if (annotation) {
      const display = !!el.closest('.katex-display');
      blocks.push({ display, latex: annotation.textContent?.trim() ?? '' });
      return;
    }

    // Fallback: reconstruct from the KaTeX DOM (lossy, but better than nothing).
    // KaTeX uses classes like .mord (math ord), .mbin (binary op), etc.
    const text = el.textContent?.trim();
    if (text && text.length > 0) {
      blocks.push({
        display: !!el.closest('.katex-display'),
        latex: text.replace(/\s+/g, ' '),
      });
    }
  });

  return blocks;
}

/**
 * Scan raw text for \(...\) and \[...\] LaTeX delimiters.
 * This catches math that was not rendered by KaTeX (e.g., in code blocks).
 */
export function extractLatexFromText(text: string): MathBlock[] {
  const blocks: MathBlock[] = [];

  // Block math: \[...\]
  const displayRegex = /\\\[([\s\S]*?)\\\]/g;
  let match: RegExpExecArray | null;
  while ((match = displayRegex.exec(text)) !== null) {
    blocks.push({ display: true, latex: match[1].trim() });
  }

  // Inline math: \(...\)
  const inlineRegex = /\\\(([\s\S]*?)\\\)/g;
  while ((match = inlineRegex.exec(text)) !== null) {
    // Exclude matches that were part of block math
    const start = match.index;
    let isInsideBlock = false;
    const blockRe = /\\\[([\s\S]*?)\\\]/g;
    let bv: RegExpExecArray | null;
    while ((bv = blockRe.exec(text)) !== null) {
      if (start > bv.index && start < bv.index + bv[0].length) {
        isInsideBlock = true;
        break;
      }
    }
    if (!isInsideBlock) {
      blocks.push({ display: false, latex: match[1].trim() });
    }
  }

  // Dollar-delimited: $$...$$ and $...$
  // CAUTION: single $ is error-prone. Only match $...$ if content
  // looks like math (contains \ commands or operators).
  const ddRegex = /\$\$([\s\S]*?)\$\$/g;
  while ((match = ddRegex.exec(text)) !== null) {
    blocks.push({ display: true, latex: match[1].trim() });
  }

  // Single $ (only if content has backslash commands — heuristic).
  const sdRegex = /\$(\\[a-zA-Z]+.*?)\$/g;
  while ((match = sdRegex.exec(text)) !== null) {
    blocks.push({ display: false, latex: match[1].trim() });
  }

  return blocks;
}

/**
 * Replace KaTeX elements in a container with their LaTeX source as text.
 * Mutates the DOM (use on a clone if you need to preserve the original).
 */
export function replaceKatexWithLatex(clone: Element): void {
  clone.querySelectorAll('.katex').forEach((el) => {
    const annotation = el.querySelector(
      'annotation[encoding="application/x-tex"]',
    );
    const latex = annotation?.textContent?.trim() ?? el.textContent?.trim() ?? '';
    const display = !!el.closest('.katex-display');

    const wrapper = display ? `$$\n${latex}\n$$` : `$${latex}$`;
    const span = document.createElement('span');
    span.textContent = wrapper;
    el.replaceWith(span);
  });
}

/* ------------------------------------------------------------------ */
/*  6. ZIP / BUNDLE CREATION (Client-Side JSZip)                       */
/* ------------------------------------------------------------------ */

/**
 * Create a ZIP file with a manifest and extracted assets.
 *
 * Use case: When transferring a conversation with images, code files,
 * and other attachments to another platform, bundle everything as a
 * self-contained ZIP that the user can download + re-upload.
 *
 * JSZip is NOT included in this project by default. Add it:
 *   npm install jszip
 *
 * The bundle structure:
 *   conversation.md          ← Markdown version with embedded images as ![alt](images/...)
 *   images/                  ← Extracted images as PNG/JPEG files
 *   files/                   ← Original attachments (CSV, PDF, etc.)
 *   code/                    ← Extracted code blocks as standalone source files
 *   manifest.json            ← Metadata (source platform, timestamp, title)
 */
export interface BundleEntry {
  path: string; // e.g., "images/dalle-1.png"
  data: Blob | string;
}

export interface BundleManifest {
  version: '1.0';
  source: string;
  title: string;
  url: string;
  capturedAt: string;
  messageCount: number;
  imageCount: number;
  fileCount: number;
  codeBlockCount: number;
}

/**
 * Create the full bundle structure as a map of path → content.
 * Returns entries ready to be zipped. JSZip handles the actual compression.
 */
export function createBundle(
  markdown: string,
  images: ExtractedImage[],
  files: ExtractedFile[],
  codeBlocks: CodeBlock[],
  manifest: BundleManifest,
): { entries: BundleEntry[]; totalSizeEstimate: number } {
  const entries: BundleEntry[] = [];
  let totalSize = 0;

  entries.push({ path: 'conversation.md', data: markdown });
  totalSize += markdown.length;

  for (const img of images) {
    // Strip the data URL prefix to get raw base64.
    const base64 = img.dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const ext = img.mimeType.split('/')[1] ?? 'png';
    entries.push({
      path: `images/${sanitizeFilename(img.alt || 'image')}.${ext}`,
      data: new Blob([bytes], { type: img.mimeType }),
    });
    totalSize += bytes.length;
  }

  for (const file of files) {
    if (!file.dataUrl) continue;
    const base64 = file.dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    entries.push({
      path: `files/${sanitizeFilename(file.name)}`,
      data: new Blob([bytes], { type: file.mimeType }),
    });
    totalSize += bytes.length;
  }

  for (let i = 0; i < codeBlocks.length; i++) {
    const block = codeBlocks[i];
    const ext = codeLangToExtension(block.language);
    entries.push({
      path: `code/${sanitizeFilename(`block-${i + 1}`)}.${ext}`,
      data: block.code,
    });
    totalSize += block.code.length;
  }

  entries.push({
    path: 'manifest.json',
    data: JSON.stringify(manifest, null, 2),
  });
  totalSize += JSON.stringify(manifest).length;

  return { entries, totalSizeEstimate: totalSize };
}

function codeLangToExtension(lang: string): string {
  const map: Record<string, string> = {
    python: 'py',
    javascript: 'js',
    typescript: 'ts',
    tsx: 'tsx',
    jsx: 'jsx',
    rust: 'rs',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    'c++': 'cpp',
    c: 'c',
    ruby: 'rb',
    php: 'php',
    swift: 'swift',
    kotlin: 'kt',
    sql: 'sql',
    bash: 'sh',
    sh: 'sh',
    zsh: 'sh',
    powershell: 'ps1',
    yaml: 'yaml',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    markdown: 'md',
    dockerfile: 'Dockerfile',
    makefile: 'Makefile',
    text: 'txt',
  };
  return map[lang.toLowerCase()] ?? 'txt';
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 100);
}

/**
 * Download a bundle as a ZIP file.
 * Requires JSZip. Call signature with JSZip injected:
 *
 *   import JSZip from 'jszip';
 *   await downloadZip(entries, 'conversation-bundle.zip');
 */
export async function downloadZip(
  entries: BundleEntry[],
  filename: string,
): Promise<void> {
  const JSZip = await loadJSZip();
  const zip = new JSZip();

  for (const entry of entries) {
    zip.file(entry.path, entry.data);
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Dynamically load JSZip from CDN (avoids bundling it).
 * For production, bundle JSZip via npm instead.
 */
type ZipLib = new () => {
  file(name: string, data: Blob | string): void;
  generateAsync(opts: {
    type: 'blob';
    compression: string;
    compressionOptions: { level: number };
  }): Promise<Blob>;
};

async function loadJSZip(): Promise<ZipLib> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src =
      'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    script.onload = () => {
      const JSZip = (window as unknown as Record<string, ZipLib>).JSZip;
      if (JSZip) resolve(JSZip);
      else reject(new Error('JSZip not found on window'));
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/* ------------------------------------------------------------------ */
/*  7. BLOB / DATA URL BEST PRACTICES IN CHROME EXTENSIONS             */
/* ------------------------------------------------------------------ */

/**
 * =======================================
 *  CORS Considerations
 * =======================================
 *
 * 1. Same-origin images: Content scripts share the page's origin. Fetching
 *    images from the same domain as the page works without CORS headers.
 *
 * 2. Cross-origin images (CDN): Most AI platforms serve images via cloud CDNs
 *    that set `Access-Control-Allow-Origin: *`. `fetch(url, { mode: 'cors' })`
 *    works for these. If not, use the background service worker as a relay.
 *
 * 3. Blob URLs: Created by the page with `URL.createObjectURL()`. These are
 *    same-origin to the page. A content script can `fetch(blobUrl)` directly.
 *
 * 4. filesystem: URLs: Used by Claude for artifact previews. These are opaque
 *    to `fetch`. Solution: use chrome.scripting.executeScript with
 *    `world: 'MAIN'` to access the page's filesystem API, OR screenshot the iframe.
 *
 * 5. data: URLs: Already in base64 form. Can be used directly without any
 *    fetch. Chrome limits data URLs in certain contexts (e.g., popup windows)
 *    but content scripts are fine.
 *
 * 6. chromium-untrusted:// : Used internally. Cannot be accessed.
 *
 * =======================================
 *  canvas.toBlob() vs canvas.toDataURL()
 * =======================================
 *
 *   toDataURL():
 *     + Returns a synchronous string (data URL).
 *     + Easy to pass via messaging.
 *     − Base64 encoding adds ~33% overhead.
 *     − Blocks main thread for large canvases.
 *     − Limited to: image/png, image/jpeg, image/webp.
 *
 *   toBlob():
 *     + Asynchronous, doesn't block main thread.
 *     + Direct binary output (no base64 overhead).
 *     + Any MIME type, any quality level.
 *     − Requires callback or Promise wrapper.
 *     − Cannot be directly serialized in chrome.runtime.sendMessage
 *       (must convert to data URL or transfer via ArrayBuffer).
 *
 *   Recommendation:
 *     − For small images (<1MB): toDataURL() — simpler code.
 *     − For large images or batch processing: toBlob() + FileReader.
 *     − For sending to background: convert blob to base64 data URL.
 *     − For local caching (IndexedDB): store the Blob directly.
 *
 * =======================================
 *  Large File Handling
 * =======================================
 *
 *  Chrome Extension storage limits:
 *    • chrome.storage.local:  10 MB default (unlimited with permission).
 *    • chrome.storage.session: 10 MB.
 *    • chrome.storage.sync:    100 KB total, 8 KB per item.
 *    • IndexedDB:              ~unlimited (prompts user for permission
 *                               above ~100 MB on some systems).
 *
 *  Strategy for large conversation bundles:
 *    1. Store metadata + text in chrome.storage.session.
 *    2. Store binary assets (images, files) in IndexedDB, keyed by hash.
 *    3. For the relay payload, include image hashes / IDs instead of data URLs.
 *    4. When injecting into the target platform, reconstruct images from
 *       IndexedDB on demand.
 *
 *  For a simpler approach (up to ~50 MB):
 *    • Use IndexedDB for the full bundle.
 *    • Use chrome.storage.session only as a "pointer" (which bundle to inject).
 *
 * =======================================
 *  Memory Management
 * =======================================
 *
 *   • Avoid keeping large data URLs in memory. Revoke blob URLs with
 *     `URL.revokeObjectURL()` after converting to data URL.
 *   • When processing many images, stream them one at a time rather than
 *     loading all concurrently (memory spikes).
 *   • The content script shares memory with the page. Large GC pauses
 *     can cause jank in the host page's UI. Keep extraction async and
 *     yield to the event loop periodically.
 *   • Use `requestIdleCallback` or chunked processing for scraping many
 *     elements.
 *   • For base64 strings: each character = 2 bytes in JS (UTF-16).
 *     A 5MB image becomes ~6.7MB base64 string → ~13.4MB memory.
 *     Use ArrayBuffer/Uint8Array if you need to hold many images.
 */

/**
 * Helper: Process many items concurrently with a pool limit.
 * Avoids memory spikes from loading all images at once.
 */
export async function asyncPool<T, R>(
  concurrency: number,
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift()!;
      results.push(await fn(item));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Extract all images from a message container (ChatGPT/Claude turn) with
 * controlled concurrency.
 */
export async function extractImages(
  container: Element,
  concurrency = 3,
): Promise<ExtractedImage[]> {
  const imgEls = findGeneratedImages(container);
  const results = await asyncPool(concurrency, imgEls, extractImageFromImg);
  return results.filter((r): r is ExtractedImage => r !== null);
}

/* ------------------------------------------------------------------ */
/*  Utility: clean inner text (collapsed whitespace, trimmed)          */
/* ------------------------------------------------------------------ */

function cleanInnerText(el: HTMLElement): string {
  return (el.innerText ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ */
/*  Re-export for convenience                                           */
/* ------------------------------------------------------------------ */

import type { CodeBlock } from '@/core/schema';
