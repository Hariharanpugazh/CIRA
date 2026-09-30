/**
 * DOM -> Markdown serializer shared by every adapter.
 *
 * Design choices:
 *  - `<pre><code>` is read with a manual walker that converts `<br>` to `\n`,
 *    because ChatGPT's CodeMirror, DeepSeek's md-code-block and others render
 *    line breaks as `<br>` and lose them under `textContent`.
 *  - Tables are converted to Markdown tables (preserves columns).
 *  - KaTeX nodes use the embedded `<annotation encoding="application/x-tex">`
 *    when present, then fall back to text.
 *  - UI noise selectors (copy buttons, citation chips) are stripped via a
 *    pre-clone pass so the original DOM is untouched.
 */

const DEFAULT_NOISE_SELECTORS = [
    'button',
    '[role="button"]',
    '[aria-hidden="true"]',
    'svg',
    '[class*="copy-button" i]',
    '[class*="action-bar" i]',
    '[class*="ds-icon-button" i]',
    '[class*="ds-atom-button" i]',
];

export interface SerializeOptions {
    /** Extra selectors to strip on top of the defaults. */
    extraNoiseSelectors?: string[];
    /** When true, keep image links as `![alt](src)`. Defaults to true. */
    keepImages?: boolean;
}

export function serializeToMarkdown(root: Element, opts: SerializeOptions = {}): string {
    if (!root) return '';
    const clone = root.cloneNode(true) as Element;
    const noise = [...DEFAULT_NOISE_SELECTORS, ...(opts.extraNoiseSelectors ?? [])];
    for (const sel of noise) {
        try {
            clone.querySelectorAll(sel).forEach((el) => el.remove());
        } catch {
            // Bad selector? Skip it.
        }
    }
    const out: string[] = [];
    walk(clone, out, opts);
    return cleanWhitespace(out.join(''));
}

function walk(node: Node, out: string[], opts: SerializeOptions): void {
    if (node.nodeType === Node.TEXT_NODE) {
        out.push(node.textContent ?? '');
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;

    if (el.classList.contains('katex')) {
        if (!el.parentElement?.closest('.katex')) {
            out.push(katexToLatex(el));
        }
        return;
    }

    switch (el.tagName) {
        case 'PRE': {
            const codeEl = el.querySelector('code');
            const lang = readCodeLanguage(el);
            const code = readCodeText(codeEl ?? el);
            out.push(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
            return;
        }
        case 'CODE':
            if (!el.closest('pre')) {
                out.push(`\`${el.textContent ?? ''}\``);
                return;
            }
            break;
        case 'TABLE':
            out.push(`\n\n${tableToMarkdown(el as HTMLTableElement)}\n\n`);
            return;
        case 'IMG': {
            if (opts.keepImages === false) return;
            const img = el as HTMLImageElement;
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
            if (!src || /favicon|sprite|s2\/favicons/i.test(src)) return;
            const alt = img.alt || img.getAttribute('aria-label') || 'image';
            out.push(`\n\n![${alt}](${src})\n\n`);
            return;
        }
        case 'BR':
            out.push('\n');
            return;
        case 'HR':
            out.push('\n\n---\n\n');
            return;
        case 'LI':
            out.push('\n- ');
            el.childNodes.forEach((c) => walk(c, out, opts));
            return;
        case 'A': {
            const href = el.getAttribute('href') ?? '';
            const text = el.textContent ?? '';
            out.push(href && !href.startsWith('javascript:') ? `[${text}](${href})` : text);
            return;
        }
        case 'STRONG':
        case 'B':
            out.push('**');
            el.childNodes.forEach((c) => walk(c, out, opts));
            out.push('**');
            return;
        case 'EM':
        case 'I':
            out.push('*');
            el.childNodes.forEach((c) => walk(c, out, opts));
            out.push('*');
            return;
        case 'H1':
            out.push('\n\n# '); el.childNodes.forEach((c) => walk(c, out, opts)); out.push('\n\n'); return;
        case 'H2':
            out.push('\n\n## '); el.childNodes.forEach((c) => walk(c, out, opts)); out.push('\n\n'); return;
        case 'H3':
            out.push('\n\n### '); el.childNodes.forEach((c) => walk(c, out, opts)); out.push('\n\n'); return;
        case 'BLOCKQUOTE':
            out.push('\n\n> '); el.childNodes.forEach((c) => walk(c, out, opts)); out.push('\n\n'); return;
    }

    el.childNodes.forEach((c) => walk(c, out, opts));
    if (/^(P|DIV|SECTION|UL|OL)$/.test(el.tagName)) out.push('\n');
}

function readCodeText(root: Element): string {
    let out = '';
    const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            out += node.textContent ?? '';
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        if (el.tagName === 'BR') {
            out += '\n';
            return;
        }
        el.childNodes.forEach(visit);
    };
    visit(root);
    return out.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

function readCodeLanguage(pre: Element): string {
    const code = pre.querySelector('code');
    const fromClass = code?.className.match(/\blanguage-([\w+#-]+)\b/)?.[1]
        ?? pre.className.match(/\blanguage-([\w+#-]+)\b/)?.[1];
    if (fromClass) return fromClass;
    const attr = code?.getAttribute('data-language') ?? pre.getAttribute('data-language');
    if (attr) return attr;
    return '';
}

function tableToMarkdown(table: HTMLTableElement): string {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const grid = rows.map((row) =>
        Array.from(row.querySelectorAll('th, td')).map((cell) =>
            (cell.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'),
        ),
    );
    const cols = Math.max(...grid.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')];
    const [head, ...body] = grid.map(pad);
    return [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...body.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
}

function katexToLatex(el: Element): string {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    const latex = annotation?.textContent?.trim() ?? el.textContent?.trim() ?? '';
    if (!latex) return '';
    return el.closest('.katex-display') ? `$$${latex}$$` : `$${latex}$`;
}

function cleanWhitespace(s: string): string {
    return s
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
