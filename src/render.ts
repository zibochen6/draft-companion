import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const allowedTags = new Set([
  'p', 'br', 'em', 'strong', 's', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span',
]);

type MarkdownToken = ReturnType<typeof markdown.parse>[number];

export function safeLink(href: string): boolean {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(href).protocol); }
  catch { return false; }
}

/**
 * Markdown-it provides tokens, never trusted DOM. Build a tiny presentation tree from
 * those tokens so message content cannot reach an HTML parser or an executable DOM sink.
 */
export function renderSafeMarkdown(container: HTMLElement, source: string): void {
  const doc = container.ownerDocument;
  const create = (tag: string): HTMLElement => doc.createElementNS(htmlNamespace, tag) as HTMLElement;
  const appendText = (parent: Node, text: string | number): void => {
    parent.appendChild(doc.createTextNode(String(text)));
  };
  const appendInertImage = (parent: Node, token: MarkdownToken): void => {
    const reference = create('span');
    reference.className = 'dc-inert-reference';
    const label = token.content || '未命名图片';
    const address = token.attrGet('src') || '';
    appendText(reference, `图片引用：${label}${address ? ` (${address})` : ''}`);
    parent.appendChild(reference);
  };
  const appendInline = (parent: Node, tokens: readonly MarkdownToken[]): void => {
    const parents: Node[] = [parent];
    for (const token of tokens) {
      const current = parents[parents.length - 1]!;
      if (token.type === 'text' || token.type === 'html_inline') appendText(current, token.content);
      else if (token.type === 'softbreak' || token.type === 'hardbreak') current.appendChild(create('br'));
      else if (token.type === 'code_inline') {
        const code = create('code'); appendText(code, token.content); current.appendChild(code);
      } else if (token.type === 'image') appendInertImage(current, token);
      else if (token.type === 'link_open') {
        const href = String(token.attrGet('href') || '');
        const element = create(safeLink(href) ? 'a' : 'span');
        if (element.tagName === 'A') {
          element.setAttribute('href', href);
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
          const title = String(token.attrGet('title') || '');
          if (title) element.setAttribute('title', title);
        }
        current.appendChild(element); parents.push(element);
      } else if (token.type === 'link_close') {
        if (parents.length > 1) parents.pop();
      } else if (token.nesting === 1 && allowedTags.has(String(token.tag))) {
        const element = create(String(token.tag));
        current.appendChild(element); parents.push(element);
      } else if (token.nesting === -1 && parents.length > 1) {
        parents.pop();
      } else if (token.content) appendText(current, token.content);
    }
  };

  const fragment = doc.createDocumentFragment();
  const parents: Node[] = [fragment];
  for (const token of markdown.parse(source, {})) {
    const current = parents[parents.length - 1]!;
    if (token.type === 'inline') {
      appendInline(current, token.children || []);
    } else if (token.type === 'fence' || token.type === 'code_block') {
      const pre = create('pre'); const code = create('code');
      appendText(code, token.content); pre.appendChild(code); current.appendChild(pre);
    } else if (token.type === 'hr') {
      current.appendChild(create('hr'));
    } else if (token.nesting === 1 && allowedTags.has(String(token.tag))) {
      const tag = String(token.tag);
      const element = create(tag);
      if (tag === 'ol') {
        const start = String(token.attrGet('start') || '');
        if (start && /^\d+$/.test(start)) element.setAttribute('start', start);
      }
      current.appendChild(element); parents.push(element);
    } else if (token.nesting === -1 && parents.length > 1) {
      parents.pop();
    } else if (token.content) {
      appendText(current, token.content);
    }
  }
  container.replaceChildren(fragment);
}
