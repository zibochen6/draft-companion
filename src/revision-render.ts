import { diffArrays } from 'diff';
import { renderSafeMarkdown } from './render';

export interface GraphemePart { value: string; added?: boolean; removed?: boolean }

/** Keep emoji and joined graphemes intact when presenting a sentence revision. */
export function graphemeDiff(before: string, after: string): GraphemePart[] {
  const Segmenter = Intl.Segmenter;
  const split = (value: string): string[] => Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment)
    : Array.from(value);
  return diffArrays(split(before), split(after)).map(part => ({
    value: part.value.join(''), added: part.added, removed: part.removed,
  }));
}

export function reconstructRevision(parts: readonly GraphemePart[]): { before: string; after: string } {
  return {
    before: parts.filter(part => !part.added).map(part => part.value).join(''),
    after: parts.filter(part => !part.removed).map(part => part.value).join(''),
  };
}

function textNodes(root: Node): Text[] {
  const result: Text[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) result.push(child as Text);
      else walk(child);
    }
  };
  walk(root);
  return result;
}

function shape(root: Node): string {
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return '#';
    if (!(node instanceof HTMLElement)) return '';
    // A different link destination is a structural change even if its label matches.
    const identity = node.tagName === 'A' ? `:${node.getAttribute('href') || ''}` : '';
    return `<${node.tagName}${identity}>${Array.from(node.childNodes).map(visit).join('')}</${node.tagName}>`;
  };
  return Array.from(root.childNodes).map(visit).join('');
}

function appendMarkedText(target: Text, before: string, after: string): void {
  const doc = target.ownerDocument;
  const fragment = doc.createDocumentFragment();
  for (const part of graphemeDiff(before, after)) {
    if (part.removed) {
      const removed = doc.createElement('del'); removed.className = 'dc-revision-remove'; removed.textContent = part.value; fragment.appendChild(removed);
    } else if (part.added) {
      const added = doc.createElement('ins'); added.className = 'dc-revision-add'; added.textContent = part.value; fragment.appendChild(added);
    } else fragment.appendChild(doc.createTextNode(part.value));
  }
  target.replaceWith(fragment);
}

function safeTree(doc: Document, markdown: string): HTMLElement {
  const result = doc.createElement('div');
  renderSafeMarkdown(result, markdown);
  return result;
}

/**
 * Renders a revision only from two already-owned strings. It never parses model HTML:
 * the source trees are made by renderSafeMarkdown, while inserted marks are created here.
 */
export function renderRevisionMarkdown(container: HTMLElement, before: string, after: string): void {
  const oldTree = safeTree(container.ownerDocument, before);
  const newTree = safeTree(container.ownerDocument, after);
  const revision = container.ownerDocument.createDocumentFragment();
  if (shape(oldTree) === shape(newTree)) {
    const display = oldTree.cloneNode(true) as HTMLElement;
    const oldText = textNodes(oldTree);
    const newText = textNodes(newTree);
    const displayText = textNodes(display);
    if (oldText.length === newText.length && oldText.length === displayText.length) {
      for (let index = displayText.length - 1; index >= 0; index--) {
        const original = oldText[index]!.data;
        const proposed = newText[index]!.data;
        if (original !== proposed) appendMarkedText(displayText[index]!, original, proposed);
      }
      display.className = 'dc-revision-inline';
      revision.appendChild(display);
    }
  }
  if (!revision.childNodes.length) {
    const structural = container.ownerDocument.createElement('div'); structural.className = 'dc-revision-structural';
    const block = (className: string, label: string, tree: HTMLElement) => {
      const section = container.ownerDocument.createElement('section'); section.className = className;
      const heading = container.ownerDocument.createElement('p'); heading.className = 'dc-revision-label'; heading.textContent = label;
      section.appendChild(heading); section.append(...Array.from(tree.childNodes)); structural.appendChild(section);
    };
    block('dc-revision-before', '原结构', oldTree); block('dc-revision-after', '建议结构', newTree);
    revision.appendChild(structural);
  }
  container.replaceChildren(revision);
}
