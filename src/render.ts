import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]!;
  const label = token.content || '未命名图片';
  const source = token.attrGet('src') || '';
  return `<span class="dc-inert-reference">${markdown.utils.escapeHtml(`图片引用：${label}${source ? ` (${source})` : ''}`)}</span>`;
};

const allowedTags = new Set([
  'P', 'BR', 'EM', 'STRONG', 'S', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'HR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'SPAN',
]);

export function safeLink(href: string): boolean {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(href).protocol); }
  catch { return false; }
}

/** Parse in an inert template, then copy only the small presentation allowlist. Never invoke Obsidian MarkdownRenderer. */
export function renderSafeMarkdown(container: HTMLElement, source: string): void {
  const doc = container.ownerDocument;
  const template = doc.createElement('template');
  template.innerHTML = markdown.render(source);
  const clean = (node: Node): Node | null => {
    if (node.nodeType === 3) return doc.createTextNode(node.textContent || '');
    if (node.nodeType !== 1) return null;
    const original = node as HTMLElement;
    if (!allowedTags.has(original.tagName)) return doc.createTextNode(original.textContent || '');
    const href = original.tagName === 'A' ? original.getAttribute('href') || '' : '';
    const tag = original.tagName === 'A' && !safeLink(href) ? 'span' : original.tagName.toLowerCase();
    const result = doc.createElement(tag);
    if (tag === 'a') {
      result.setAttribute('href', href);
      result.setAttribute('target', '_blank');
      result.setAttribute('rel', 'noopener noreferrer');
      const title = original.getAttribute('title');
      if (title) result.setAttribute('title', title);
    }
    if (tag === 'span' && original.classList.contains('dc-inert-reference')) result.className = 'dc-inert-reference';
    if (tag === 'ol' && /^\d+$/.test(original.getAttribute('start') || '')) result.setAttribute('start', original.getAttribute('start')!);
    for (const child of Array.from(original.childNodes)) { const copied = clean(child); if (copied) result.appendChild(copied); }
    return result;
  };
  const fragment = doc.createDocumentFragment();
  for (const node of Array.from(template.content.childNodes)) { const copied = clean(node); if (copied) fragment.appendChild(copied); }
  container.replaceChildren(fragment);
}
