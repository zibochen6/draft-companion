import * as http from 'node:http';
import type { App, WorkspaceLeaf } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../src/controller';
import { Documents } from '../src/documents';
import { Store } from '../src/store';
import type { ChatMessage, Provider, TaskMode } from '../src/types';
import { MarkdownView, TestEditor, TFile } from './obsidian-mock';

const SERVERS: http.Server[] = [];
const HEADER = '---\ntitle: 公众号创作闭环测试\nstatus: 测试素材\n---\n';
const OPINION = '我认为工具的价值取决于它是否解决具体问题，而不是功能数量。';
const STRUCTURES = '\n[[工作流材料]]\n![示例图片](images/test.png)\n![[参考素材]]\n```ts\nconst purpose = "解决真实问题";\n```\n';
const MATERIAL = HEADER + '# 尚未成稿的素材\n\n读者：想把 AI 用在日常工作中的人。\n\n' + OPINION + '\n\n我们有一个任务拆解示例，尚未做效率测量。\n' + STRUCTURES;
const DRAFT = '# 先找问题，再选工具\n\n准备介绍一个新工具时，先写清楚它要帮助读者完成什么工作。\n\n' + OPINION + '\n\n以任务拆解为例，可以从明确交付目标、整理输入和检查结果三个步骤开始。该示例不代表已测量收益。\n' + STRUCTURES;
const REVISED = DRAFT.replace('以任务拆解为例，可以从', '沿着这个判断，以任务拆解为例，可以从');
const REQUESTS = [
  '从当前素材找一个具体选题。',
  '确定选题为先找问题再选工具，请组织大纲。',
  '根据已确定的大纲写一版初稿。',
  '审阅当前已应用正文，给出最重要的意见。',
  '我拒绝删除那段个人观点，请在后续保留它。',
  '只改善观点到任务拆解之间的衔接，不删除我保留的观点。',
  '根据最新正文给标题与发布摘要。',
];

interface Captured { input: string; messages: ChatMessage[]; body: Record<string, unknown> }

async function mockHTTP(captured: Captured[]): Promise<string> {
  const replies = new Map<string, string>([
    [REQUESTS[0]!, '推荐选题：先找具体工作问题，再选择 AI 工具。读者是希望改善日常工作的人；已有任务拆解素材，缺少实测结果，不能声称效率提升。'],
    [REQUESTS[1]!, '主旨：工具选择服务于真实工作。大纲：问题与读者 → 作者判断 → 任务拆解示例 → 限制与尝试方式。'],
    [REQUESTS[2]!, JSON.stringify({ explanation: '初稿说明：围绕已确定的读者与角度整理素材。', replacement: DRAFT, notes: ['待核实清单：图片与链接尚未实际访问。'] })],
    [REQUESTS[3]!, `表达问题：可考虑删除“${OPINION}”，或改善它和任务拆解之间的衔接。这是建议，尚未应用。`],
    [REQUESTS[4]!, '已理解你的拒绝：保留个人观点，后续仅讨论衔接。'],
    [REQUESTS[5]!, JSON.stringify({ explanation: '改稿说明：仅补充一处衔接，保留已明确要求保留的观点。', replacement: REVISED, notes: ['待核实清单：本文没有效率测量，不应新增收益数字。'] })],
    [REQUESTS[6]!, '标题候选：先找问题，再选工具；让 AI 工具回到真实工作；从一个任务开始选择工具。\n推荐标题：先找问题，再选工具。\n发布摘要：从任务拆解出发，说明如何判断工具是否值得尝试，以及哪些效果仍需要验证。'],
  ]);
  const instance = http.createServer((req, res) => {
    if (req.url === '/creative/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'explicit-mock-model' }] }));
      return;
    }
    if (req.url !== '/creative/v1/chat/completions') { res.statusCode = 404; res.end('{}'); return; }
    const buffers: Buffer[] = [];
    req.on('data', (part: Buffer) => buffers.push(part));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as Record<string, unknown>;
        const messages = body.messages as ChatMessage[];
        const current = messages.at(-1)?.content ?? '';
        const input = current.split('【用户本轮要求】\n').at(-1) ?? '';
        captured.push({ input, messages, body });
        const response = replies.get(input);
        if (!response) { res.statusCode = 400; res.end('{}'); return; }
        res.setHeader('Content-Type', 'text/event-stream');
        const characters = [...response];
        const split = Math.floor(characters.length / 2);
        for (const part of [characters.slice(0, split).join(''), characters.slice(split).join('')]) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
        }
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } catch { res.statusCode = 500; res.end('{}'); }
    });
  });
  SERVERS.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Mock HTTP did not start');
  return `http://127.0.0.1:${address.port}/creative/v1`;
}

afterEach(async () => {
  await Promise.all(SERVERS.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe('simulated article workflow through real local HTTP transport', () => {
  it('completes topic → outline → draft → review/refusal → revision → title without writing discussion or notes', async () => {
    const captured: Captured[] = [];
    const baseUrl = await mockHTTP(captured);
    const file = new TFile('测试资料/公众号素材.md');
    const editor = new TestEditor(MATERIAL);
    const view = new MarkdownView(file, editor);
    const leaf = { view };
    const app = {
      workspace: { getLeavesOfType: () => [leaf], getMostRecentLeaf: () => leaf },
      vault: { getAbstractFileByPath: (path: string) => path === file.path ? file : null, read: async () => '刻意过期的磁盘素材', process: async () => { throw new Error('This workflow must use the live source editor'); } },
      secretStorage: { getSecret: () => null },
    } as unknown as App;
    const store = new Store(null, async () => {});
    const documents = new Documents(app, store.data.sessions);
    documents.focus(leaf as unknown as WorkspaceLeaf);
    const controller = new Controller(app, store, documents, () => {});
    const provider: Provider = { id: 'mock-http', name: '明确标注的模拟 HTTP 服务', baseUrl, secretRef: '', model: '', stream: true, timeoutMs: 2000 };
    store.data.providers = [provider]; store.data.activeProviderId = provider.id;
    const models = await controller.models(provider);
    expect(models).toEqual([{ id: 'explicit-mock-model' }]);
    provider.model = models[0]!.id;
    const roles = store.data.roles;
    const roleSequence = [roles[0]!, roles[1]!, roles[2]!, roles[3]!, roles[3]!, roles[4]!, roles[5]!];
    const modes: TaskMode[] = ['discuss', 'discuss', 'edit', 'discuss', 'discuss', 'edit', 'discuss'];
    const sameSession = controller.currentSession()!;
    sameSession.brief = '保持作者观点，不声称有实测收益。';

    for (let step = 0; step < REQUESTS.length; step++) {
      const beforeRoleSwitch = captured.length;
      const before = editor.text;
      await controller.chooseRole(roleSequence[step]!.id);
      expect(captured.length).toBe(beforeRoleSwitch);
      expect(editor.text).toBe(before);
      await controller.send(REQUESTS[step]!, modes[step]!, 'body');
      expect(controller.currentSession()).toBe(sameSession);
      expect(captured).toHaveLength(step + 1);
      const request = captured[step]!;
      expect(Object.keys(request.body).sort()).toEqual(['messages', 'model', 'stream']);
      expect(request.body.model).toBe('explicit-mock-model');
      expect(request.body.stream).toBe(true);
      expect(request.input).toBe(REQUESTS[step]);
      const systems = request.messages.filter((message) => message.role === 'system');
      expect(systems).toHaveLength(1);
      expect(systems[0]!.content).toContain(roleSequence[step]!.systemPrompt);
      for (const other of roles.filter((role) => role.id !== roleSequence[step]!.id)) expect(systems[0]!.content).not.toContain(other.systemPrompt);
      expect(request.messages.map((message) => message.content).join('\n').split(before)).toHaveLength(2);
      expect(request.messages.at(-1)!.content).not.toContain('刻意过期的磁盘素材');
      if (modes[step] === 'edit') {
        const candidate = sameSession.candidate!;
        expect(candidate.state).toBe('ready');
        expect(editor.text).toBe(before); // Receiving a candidate never writes it.
        await controller.apply(candidate);
        expect(candidate.state).toBe('applied');
        expect(editor.text).toBe(HEADER + (step === 2 ? DRAFT : REVISED));
      } else {
        expect(editor.text).toBe(before);
      }
      expect(editor.text.startsWith(HEADER)).toBe(true);
      expect(editor.text).not.toMatch(/初稿说明：|改稿说明：|待核实清单：|标题候选：|发布摘要：/);
      expect(editor.text).toContain(OPINION);
      expect(editor.text).toContain(STRUCTURES);
    }

    const revisionMessages = captured[5]!.messages;
    expect(revisionMessages.some((message) => message.role === 'user' && message.content === REQUESTS[4])).toBe(true);
    expect(revisionMessages.some((message) => message.content.includes('已应用候选'))).toBe(true);
    expect(captured[6]!.messages.at(-1)!.content).toContain(HEADER + REVISED);
    expect(sameSession.messages.filter((message) => message.role === 'assistant').map((message) => message.roleName)).toEqual(roleSequence.map((role) => role.name));
    expect(sameSession.messages.at(-1)!.content).toContain('发布摘要：');
    expect(editor.transactions).toBe(2);
    expect(controller.running).toBeUndefined();
    controller.close();
  });
});
