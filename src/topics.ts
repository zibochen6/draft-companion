import MarkdownIt from 'markdown-it';
import { randomUUID } from 'node:crypto';
import { bodyStart } from './editing';

export interface TopicItem {
  ref: string; documentRef: string;
  from: number; to: number; statusFrom: number; statusTo: number;
  raw: string; title: string; checked: boolean; section: string; description: string; links: string[];
}

const markdown = new MarkdownIt({ html: true, linkify: true });
type Token = ReturnType<typeof markdown.parse>[number];
const task = /^([ \t\u00a0]*)([-*+]|\d{1,9}[.)])([ \t\u00a0]+)\[([ xX\u00a0])\]([ \t\u00a0]+|$)(.*)$/;

function plain(tokens: readonly Token[]): string {
  return tokens.map(token => token.type === 'softbreak' || token.type === 'hardbreak' ? '\n'
    : token.type === 'text' || token.type === 'code_inline' || token.type === 'image' ? token.content : '').join('');
}

/** Parse the Markdown structure, but keep all editing coordinates in the original text. */
export function parseTopicItems(text: string, documentRef: string): TopicItem[] {
  let start: number;
  try { start = bodyStart(text); } catch { return []; }
  const lines: { from: number; text: string }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    lines.push({ from: offset, text: line.endsWith('\r') ? line.slice(0, -1) : line });
    offset += line.length + 1;
  }
  // NBSP can arrive from copied checkboxes. Normalize only the parsing copy;
  // its UTF-16 length and the original source spans remain unchanged.
  const masked = text.slice(0, start).replace(/[^\r\n]/g, ' ') + text.slice(start);
  const tokens = markdown.parse(masked.replace(/\u00a0/g, ' '), {});
  const result: TopicItem[] = [], headings: string[] = [];
  let itemDepth = 0, quoteDepth = 0;
  let active: { item: TopicItem; parts: Token[]; firstBody: string } | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === 'blockquote_open') quoteDepth++;
    if (token.type === 'blockquote_close') quoteDepth--;
    if (token.type === 'heading_open' && !itemDepth && !quoteDepth) {
      const level = Number(token.tag.slice(1));
      headings.length = level;
      headings[level - 1] = plain(tokens[index + 1]?.children ?? []).trim();
    }
    if (token.type === 'list_item_open') {
      if (!itemDepth && !quoteDepth && token.map) {
        const line = lines[token.map[0]], end = lines[token.map[1]]?.from ?? text.length;
        const match = line && task.exec(line.text);
        if (line && match && line.from >= start) {
          const statusFrom = line.from + match[1]!.length + match[2]!.length + match[3]!.length + 1;
          active = { firstBody: match[6]!, parts: [], item: {
            ref: `topic_${randomUUID()}`, documentRef, from: line.from, to: end,
            statusFrom, statusTo: statusFrom + 1, raw: text.slice(line.from, end),
            title: '', checked: /[xX]/.test(match[4]!), section: headings.filter(Boolean).join(' / '), description: '', links: [],
          } };
        }
      }
      itemDepth++;
    } else if (token.type === 'inline' && itemDepth === 1 && active) {
      active.parts.push(token);
    } else if (token.type === 'list_item_close') {
      if (itemDepth === 1 && active) {
        const children = active.parts.flatMap(part => part.children ?? []);
        const content = active.parts.map(part => plain(part.children ?? [])).join('\n').replace(/^\[[ xX\u00a0]\][ \t\u00a0]*/, '').trim();
        const strong = /^\*\*(.+?)\*\*/.exec(active.firstBody.trim());
        const preferred = strong ? plain(markdown.parseInline(strong[1]!, {})[0]?.children ?? []).trim() : '';
        const title = preferred || content.split(/\n|\s+[—–]\s+|[｜|]/)[0]!.replace(/https?:\/\/\S+/g, '').trim();
        active.item.title = title;
        active.item.description = content.startsWith(title) ? content.slice(title.length).replace(/^[ \t\u00a0—–｜|]+/, '').trim() : content;
        active.item.links = [...new Set([
          ...children.filter(child => child.type === 'link_open').map(child => String(child.attrGet('href') ?? '')).filter(Boolean),
          ...[...children.filter(child => child.type === 'text').map(child => child.content).join('\n').matchAll(/\[\[([^\]\n]+)\]\]/g)].map(match => `[[${match[1]}]]`),
        ])];
        if (title) result.push(active.item);
        active = undefined;
      }
      itemDepth--;
    }
  }
  return result;
}
