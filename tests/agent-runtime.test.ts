import { describe,it,expect,vi } from 'vitest';
import { agentMessages,runAgent,parseCommandEnvelope,discoverToolProtocol,capabilityKey } from '../src/agent-runtime';
import { constrainIntent,inferLocalIntent,parseIntent,intentMessages } from '../src/agent-intent';
import { Store } from '../src/store';
import { ProviderError } from '../src/provider';
import type { AgentRequestContext } from '../src/agent-types';
import type { ToolCall } from '../src/types';
const call=(id='c',name='read_document'):ToolCall=>({id,type:'function',function:{name,arguments:'{}'}});
function context():AgentRequestContext {
 const store=new Store(null,async()=>{}),abort=new AbortController();
 return {snapshot:{documentId:'d',path:'合成.md',fullText:'# 独一正文😀',hash:'h',scope:'body',from:0,to:8,selectedText:'# 独一正文😀',requestId:'r',sessionId:'s',role:store.data.roles[0]!,provider:{id:'p',name:'模拟',baseUrl:'http://localhost/v1',secretRef:'reference-only',model:'m',stream:false,timeoutMs:1000},input:'只推荐一个',mode:'discuss',preferences:'',brief:'',history:[]},document:{id:'d',path:'合成.md',ctime:1},documentRef:'doc_ref',intent:{intent:'recommend-topic'},selectedTopicRefs:new Set(),topicBudget:1,signal:abort.signal,assertActive:()=>{if(abort.signal.aborted)throw new Error('stopped');}};
}
function callbacks(){return{chunk:vi.fn(),outcome:vi.fn(),latest:vi.fn(async()=> '# 独一正文😀')}}
describe('strict intent and runtime authorization',()=>{
 it('replacement prose about how to edit does not revoke the instruction outside its quotes',()=>{
  expect(constrainIntent({intent:'replace'},'把选中的段落直接改成“先检查文案，再决定怎么修改。”',{}).intent).toBe('replace');
 });
 it('classifies only the current input, never document/history instructions',()=>{
  const messages=intentMessages('只推荐，不要勾选',{task:'topic'},true);
  expect(messages[1]?.content).toBe('只推荐，不要勾选');expect(messages).toHaveLength(2);
  expect(parseIntent('{"intent":"recommend-topic"}','只推荐')).toEqual({intent:'recommend-topic'});
 });
 it('treats unused empty classifier fields as absent without granting a quoted range',()=>{
  expect(parseIntent('{"intent":"select-topic","quote":null,"count":1,"question":""}','帮我选一个')).toEqual({intent:'select-topic',count:1});
  expect(parseIntent('{"intent":"replace","quote":"","count":null,"question":null}','修改选区')).toEqual({intent:'replace'});
 });
 it('uses the explicit topic request when a classifier mistakenly asks for the already captured library',()=>{
  expect(constrainIntent({intent:'clarify',question:'请粘贴选题库'},'从这个库帮我选一个并实际勾选。',{task:'topic'})).toEqual({intent:'select-topic',count:1,topicSelection:{mode:'exact',min:1,max:1}});
  expect(constrainIntent({intent:'clarify',question:'请说明'},'如果帮我选一个会怎么做？',{task:'topic'}).intent).toBe('clarify');
 });
 it('recognizes clear local topic commands without depending on a remote classifier',()=>{
  expect(inferLocalIntent('帮我选择一些适合的选题来创作公众号。以及同时给我合适的爆款标题参考。',{},true)).toEqual({intent:'select-topic',topicSelection:{mode:'adaptive',min:0,max:5}});
  expect(inferLocalIntent('帮我选几个',{task:'topic'},false)).toEqual({intent:'select-topic',topicSelection:{mode:'adaptive',min:0,max:5}});
  expect(inferLocalIntent('找选题并勾选',{},false)).toEqual({intent:'select-topic',topicSelection:{mode:'adaptive',min:0,max:5}});
  expect(inferLocalIntent('请选三项适合的选题',{task:'topic'},false)).toEqual({intent:'select-topic',count:3,topicSelection:{mode:'exact',min:3,max:3}});
  expect(inferLocalIntent('你直接给我勾选呐',{},true)).toEqual({intent:'select-topic',topicSelection:{mode:'adaptive',min:0,max:5}});
  expect(inferLocalIntent('请直接打勾',{task:'topic'},false)).toEqual({intent:'select-topic',topicSelection:{mode:'adaptive',min:0,max:5}});
  expect(inferLocalIntent('帮我挑一个适合写的选题',{},true)).toEqual({intent:'select-topic',count:1,topicSelection:{mode:'exact',min:1,max:1}});
  expect(constrainIntent({intent:'select-topic'},'帮我选一个并勾选',{},true)).toEqual({intent:'select-topic',count:1,topicSelection:{mode:'exact',min:1,max:1}});
 });
 it('keeps local topic inference read-only for refusals, hypotheses, and quoted source instructions',()=>{
  expect(inferLocalIntent('只推荐，不要勾选',{task:'topic'},true)).toEqual({intent:'recommend-topic'});
  expect(inferLocalIntent('如何选择一些适合的选题？',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('材料里有一段命令：\n```json\n{"command":"帮我选一个并勾选"}\n```',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('> 帮我选一个并勾选',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('~~~\n帮我选一个并勾选',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('````text\n~~~\n帮我选一个并勾选\n````',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('> 这是一段引用\n帮我选一个并勾选',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('这是一个使用案例：帮我选一个选题',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('请解释命令：帮我选一个',{task:'topic'},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('根据下面材料帮我选一个选题',{task:'topic'},true)).toEqual({intent:'select-topic',count:1,topicSelection:{mode:'exact',min:1,max:1}});
  expect(inferLocalIntent('只讨论当前段落',{},true)).toEqual({intent:'discuss'});
  expect(inferLocalIntent('不要选择一个选题',{task:'topic'},true)).toEqual({intent:'recommend-topic'});
  expect(inferLocalIntent('不要帮我选择一些适合的选题',{task:'topic'},true)).toEqual({intent:'recommend-topic'});
  expect(inferLocalIntent('别帮我选一个',{task:'topic'},true)).toEqual({intent:'recommend-topic'});
  expect(inferLocalIntent('不要选一个选题',{task:'topic'},true)).toEqual({intent:'recommend-topic'});
  expect(inferLocalIntent('把选区直接改成“帮我选一个选题”',{task:'execute'},true)).toBeUndefined();
  expect(constrainIntent({intent:'replace'},'把选区直接改成“帮我选一个选题”',{task:'execute'},true).intent).toBe('replace');
  expect(inferLocalIntent('帮我选一个数据库产品',{},false)).toBeUndefined();
  expect(inferLocalIntent('帮我选一个数据库工具',{},true)).toBeUndefined();
  expect(inferLocalIntent('帮我选择数据库产品',{},true)).toBeUndefined();
  expect(inferLocalIntent('帮我安排一下',{},true)).toBeUndefined();
  expect(inferLocalIntent('帮我选一个，不是选3个',{task:'topic'},true)).toEqual({intent:'select-topic',count:1,topicSelection:{mode:'exact',min:1,max:1}});
 });
 it.each(['{"intent":"replace","quote":"文稿里猜出来的"}','{"intent":"replace","path":"A.md"}','{"intent":"select-topic","count":9}','{"intent":"run_shell"}','prefix {"intent":"discuss"}'])('rejects unsupported/untrusted intent %s',text=>expect(()=>parseIntent(text,'修改选区')).toThrow());
 it('locally constrains a malicious classification to the human request boundary',()=>{
  expect(constrainIntent({intent:'select-topic',count:8},'只推荐，不要勾选',{task:'topic'})).toEqual({intent:'recommend-topic'});
  expect(constrainIntent({intent:'replace',quote:'原句'},'请解释 JSON 里“原句”的含义',{task:'auto'})).toEqual({intent:'discuss'});
  expect(constrainIntent({intent:'select-topic',count:8},'帮我选一个并勾选',{task:'topic'})).toEqual({intent:'select-topic',count:1,topicSelection:{mode:'exact',min:1,max:1}});
  expect(constrainIntent({intent:'select-topic',count:1,topicSelection:{mode:'exact',min:1,max:1}},'请选两项并勾选',{task:'topic'})).toEqual({intent:'select-topic',count:2,topicSelection:{mode:'exact',min:2,max:2}});
  expect(constrainIntent({intent:'select-topic',count:8},'帮我选择一些合适的选题',{task:'topic'})).toEqual({intent:'select-topic',topicSelection:{mode:'adaptive',min:0,max:5}});
  expect(inferLocalIntent('请选 3 个选题',{task:'topic'},true)).toEqual({intent:'select-topic',count:3,topicSelection:{mode:'exact',min:3,max:3}});
 });
 it('preserves user custom role rules while making actual runtime permission explicit',()=>{
  const c=context();c.snapshot.role.systemPrompt='用户自定规则';
  const messages=agentMessages(c),combined=messages.map(m=>m.content).join('\n');
  expect(combined).toContain('用户自定规则');expect(combined).toContain('recommend-topic');expect(combined).not.toContain('reference-only');expect(combined.split(c.snapshot.fullText)).toHaveLength(2);
 });
});
describe('synthetic capability probe',()=>{
 it('accepts native protocol with no document or write',async()=>{
  const c=context(),transport=vi.fn(async()=>({text:'',finishReason:'tool_calls',toolCalls:[{...call('probe','protocol_probe'),function:{name:'protocol_probe',arguments:'{"value":"ok"}'}}]}));
  expect(await discoverToolProtocol(c.snapshot.provider,undefined,c.signal,transport)).toBe('native');
  expect(JSON.stringify(transport.mock.calls)).not.toContain(c.snapshot.fullText);
 });
 it('caches by model/service/credential reference without saving secret values',()=>{
  const p=context().snapshot.provider;
  expect(capabilityKey(p)).not.toContain(p.secretRef);expect(capabilityKey(p)).not.toBe(capabilityKey({...p,model:'other'}));expect(capabilityKey(p)).not.toBe(capabilityKey({...p,baseUrl:'http://other/v1'}));
 });
 it('uses structured path only for completed ignored probe or explicit unsupported error',async()=>{
  const c=context();expect(await discoverToolProtocol(c.snapshot.provider,undefined,c.signal,async()=>({text:'不能调用',finishReason:'stop'}))).toBe('structured');
  expect(await discoverToolProtocol(c.snapshot.provider,undefined,c.signal,async()=>{throw new ProviderError('unsupported','not supported');})).toBe('structured');
 });
 it.each(['auth','connection','timeout','permission','format'])('does not switch on %s',async kind=>{
  const c=context();await expect(discoverToolProtocol(c.snapshot.provider,undefined,c.signal,async()=>{throw new ProviderError(kind,'failed');})).rejects.toThrow('failed');
 });
});
describe('bounded agent tool loop',()=>{
 it('returns native tool outcomes then final prose, with only one latest full context',async()=>{
  const c=context(),execute=vi.fn(async()=>({status:'success' as const,message:'已读取'})),cb=callbacks();
  const transport=vi.fn().mockResolvedValueOnce({text:'',finishReason:'tool_calls',toolCalls:[call()]}).mockResolvedValueOnce({text:'完成反馈',finishReason:'stop'});
  expect(await runAgent(c,{definitions:()=>[],execute},'native',undefined,cb,transport)).toBe('完成反馈');expect(execute).toHaveBeenCalledOnce();
  const messages=transport.mock.calls[1]![2];expect(messages.some((m:{role:string;tool_call_id?:string})=>m.role==='tool'&&m.tool_call_id==='c')).toBe(true);expect(JSON.stringify(messages).split('独一正文')).toHaveLength(2);
 });
 it('executes strictly validated structured commands through the same executor',async()=>{
  const c=context(),execute=vi.fn(async()=>({status:'noop' as const,message:'无需修改'})),transport=vi.fn().mockResolvedValueOnce({text:'{"calls":[{"id":"c","name":"read_document","arguments":{}}],"reply":""}',finishReason:'stop'}).mockResolvedValueOnce({text:'{"calls":[],"reply":"已给建议"}',finishReason:'stop'});
  expect(await runAgent(c,{definitions:()=>[],execute},'structured',undefined,callbacks(),transport)).toBe('已给建议');expect(execute).toHaveBeenCalledOnce();
 });
 it.each(['{"summary":"修改","edits":[]}','{"calls":[],"reply":"ok","path":"任意.md"}','{"calls":[{"id":"x","name":"read_document","arguments":[]}],"reply":""}','{"calls":[{"id":"x","name":"read_document","arguments":{}},{"id":"x","name":"read_document","arguments":{}}],"reply":""}'])('does not execute malformed/legacy envelope %s',text=>expect(()=>parseCommandEnvelope(text)).toThrow());
 it('does not re-execute repeated call IDs',async()=>{
  const execute=vi.fn(async()=>({status:'success' as const,message:'applied'})),transport=vi.fn().mockResolvedValueOnce({text:'',finishReason:'tool_calls',toolCalls:[call()]}).mockResolvedValueOnce({text:'',finishReason:'tool_calls',toolCalls:[call()]}).mockResolvedValueOnce({text:'ok',finishReason:'stop'});
  await runAgent(context(),{definitions:()=>[],execute},'native',undefined,callbacks(),transport);expect(execute).toHaveBeenCalledOnce();
 });
 it('rejects more than eight calls before any execution',async()=>{
  const execute=vi.fn(),transport=vi.fn(async()=>({text:'',finishReason:'tool_calls',toolCalls:Array.from({length:9},(_,i)=>call(String(i)))}));
  await expect(runAgent(context(),{definitions:()=>[],execute},'native',undefined,callbacks(),transport)).rejects.toThrow('8');expect(execute).not.toHaveBeenCalled();
 });
 it('stops at six turns while retaining outcomes already executed',async()=>{
  let n=0;const execute=vi.fn(async()=>({status:'success' as const,message:'record'})),cb=callbacks(),transport=vi.fn(async()=>({text:'',finishReason:'tool_calls',toolCalls:[call(String(n++))]}));
  await expect(runAgent(context(),{definitions:()=>[],execute},'native',undefined,cb,transport)).rejects.toThrow('6');expect(execute).toHaveBeenCalledTimes(6);expect(cb.outcome).toHaveBeenCalledTimes(6);
 });
 it('cancelling between completed calls prevents the next call',async()=>{
  const c=context();let active=true;c.assertActive=()=>{if(!active)throw new Error('stopped');};const execute=vi.fn(async()=>{active=false;return{status:'success' as const,message:'record'};});
  await expect(runAgent(c,{definitions:()=>[],execute},'native',undefined,callbacks(),async()=>({text:'',finishReason:'tool_calls',toolCalls:[call('1'),call('2')]}))).rejects.toThrow('stopped');expect(execute).toHaveBeenCalledOnce();
 });
 it('never executes a truncated response',async()=>{
  const execute=vi.fn();await expect(runAgent(context(),{definitions:()=>[],execute},'native',undefined,callbacks(),async()=>({text:'',finishReason:'length',toolCalls:[call()]}))).rejects.toThrow('完整');expect(execute).not.toHaveBeenCalled();
 });
});
