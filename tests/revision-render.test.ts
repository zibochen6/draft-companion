// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { graphemeDiff, reconstructRevision, renderRevisionMarkdown } from '../src/revision-render';

describe('safe review revision renderer', () => {
  it('keeps Chinese graphemes and emoji whole while preserving both reconstructions', () => {
    const parts = graphemeDiff('你好🙂，原句', '你好👨‍👩‍👧‍👦，新句');
    expect(reconstructRevision(parts)).toEqual({ before: '你好🙂，原句', after: '你好👨‍👩‍👧‍👦，新句' });
  });
  it('marks only controlled changes inside a compatible safe markdown tree', () => {
    const target = document.createElement('div');
    renderRevisionMarkdown(target, '欢迎访问[旧链接](https://example.com) 🙂', '欢迎访问[新链接](https://example.com) 👋');
    expect(target.querySelectorAll('ins')).not.toHaveLength(0);
    expect(target.querySelectorAll('del')).not.toHaveLength(0);
    expect(target.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(target.querySelector('script, img, iframe')).toBeNull();
  });
  it('labels structural markdown changes rather than pretending they are a sentence patch', () => {
    const target = document.createElement('div');
    renderRevisionMarkdown(target, '一段文字', '- 一段文字\n- 新项目');
    expect(target.querySelector('.dc-revision-structural')).not.toBeNull();
    expect(target.textContent).toContain('原结构');
    expect(target.textContent).toContain('建议结构');
    expect(target.querySelector('ul')).not.toBeNull();
  });
  it('does not turn raw model HTML or images into executable/loaded elements', () => {
    const target = document.createElement('div');
    renderRevisionMarkdown(target, '<script>alert(1)</script>', '![cover](https://example.com/x.png)');
    expect(target.querySelector('script, img, iframe, svg')).toBeNull();
    expect(target.textContent).toContain('图片引用');
  });
});
