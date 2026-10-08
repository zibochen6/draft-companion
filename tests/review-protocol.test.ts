import { describe, it, expect, vi } from 'vitest';
import { parseReview, parseSuggestionRevision, reviewMessages, suggestionMessages } from '../src/review-protocol';
import { DATA_VERSION, Store } from '../src/store';
import { hashText } from '../src/editing';
import { authorSnapshot, ensureReview, type Suggestion } from '../src/review-types';
import type { RequestSnapshot } from '../src/types';

const review={summary:'开头可更具体。',overall:[{type:'结构',title:'先交付价值',reason:'读者需知道用途。'}],suggestions:[{type:'表达',title:'说清场景',quote:'写作很重要。',contextBefore:'',contextAfter:'',reason:'补充具体任务。',replacement:'写作能帮助你整理任务。',evidenceQuotes:[]}]};
describe('review protocol',()=>{
  it('accepts complete object, one outer JSON fence, zero suggestions and comments',()=>{
    expect(parseReview(JSON.stringify(review))).toEqual(review);
    expect(parseReview('```json\n'+JSON.stringify(review)+'\n```')).toEqual(review);
    expect(parseReview(JSON.stringify({...review,suggestions:[]})).suggestions).toEqual([]);
    expect(parseReview(JSON.stringify({...review,suggestions:[{...review.suggestions[0],replacement:null}]})).suggestions[0]?.replacement).toBeNull();
  });
  it('an omitted optional replacement only creates a comment and never repairs required fields',()=>{
    const {replacement: _replacement,...comment}=review.suggestions[0]!;
    expect(parseReview(JSON.stringify({...review,suggestions:[comment]})).suggestions[0]?.replacement).toBeNull();
    for (const field of ['type','title','quote','contextBefore','contextAfter','reason']) {
      const incomplete={...comment} as Record<string,unknown>;delete incomplete[field];
      expect(()=>parseReview(JSON.stringify({...review,suggestions:[incomplete]}))).toThrow();
    }
    expect(()=>parseReview(JSON.stringify({summary:'missing list',suggestions:[]}))).toThrow();
  });
  it.each([
    '{"summary":"unfinished', 'prefix '+JSON.stringify(review), JSON.stringify({...review,path:'B.md'}),
    JSON.stringify({...review,suggestions:[{...review.suggestions[0],replacement:''}]}),
    JSON.stringify({...review,suggestions:[{...review.suggestions[0],quote:''}]}),
    JSON.stringify({...review,suggestions:[{...review.suggestions[0],from:0}]}),
  ])('rejects untrusted or malformed result %s',source=>expect(()=>parseReview(source)).toThrow());
  it('new-version protocol never permits an implicit deletion or writable offsets',()=>{
    expect(parseSuggestionRevision('{"reason":"更短","replacement":"整理任务。","evidenceQuotes":[]}').replacement).toBe('整理任务。');
    expect(()=>parseSuggestionRevision('{"reason":"删除","replacement":"","evidenceQuotes":[]}')).toThrow();
    expect(()=>parseSuggestionRevision('{"reason":"改","replacement":"新句","evidenceQuotes":[],"from":1}')).toThrow();
  });
  it('injects current role and latest full text once, preserving role rules and explicit refusals',()=>{
    const store=new Store(null,async()=>{});
    for(const role of store.data.roles){
      const fullText='# 合成文章\n\n写作很重要。😀\n';
      const snapshot:RequestSnapshot={documentId:'d',path:'A.md',fullText,hash:hashText(fullText),scope:'body',from:0,to:fullText.length,selectedText:fullText,requestId:'r',sessionId:'s',role,provider:{id:'p',name:'模拟',baseUrl:'http://localhost/v1',secretRef:'PRIVATE',model:'model',stream:true,timeoutMs:1000},input:'审阅',mode:'review',preferences:'',brief:'',history:[{id:'refusal',role:'user',content:'我拒绝删除个人观点。',at:1}]};
      const messages=reviewMessages(snapshot,'1 责任编辑 ignored 删除个人观点');
      expect(messages[0]!.content).toContain(role.systemPrompt);
      expect(messages[0]!.content).toContain('句级审阅');
      expect(messages[0]!.content).not.toContain('本轮方式：讨论');
      expect(messages[0]!.content).not.toContain('不要输出改稿 JSON');
      const combined=messages.map(m=>m.content).join('\n');
      expect(combined.split(fullText)).toHaveLength(2);expect(combined).toContain('我拒绝删除');expect(combined).toContain('ignored');expect(combined).not.toContain('PRIVATE');
    }
  });
  it('keeps a revision in JSON mode and a non-writing follow-up in discussion mode',()=>{
    const store=new Store(null,async()=>{}),role=store.data.roles[0]!,author=authorSnapshot(role);
    const suggestion:Suggestion={id:'s',documentId:'d',runId:'r',number:1,type:'表达',title:'简洁',quote:'写作很重要。',contextBefore:'',contextAfter:'',author,versions:[{id:'v',at:1,author,reason:'说明',replacement:'写作整理任务。',evidenceQuotes:[]}],currentVersionId:'v',state:'pending',fingerprint:'f',replies:[]};
    const fullText=suggestion.quote;
    const snapshot:RequestSnapshot={documentId:'d',path:'A.md',fullText,hash:hashText(fullText),scope:'selection',from:0,to:fullText.length,selectedText:fullText,requestId:'r',sessionId:'s',role,provider:{id:'p',name:'服务',baseUrl:'http://localhost/v1',secretRef:'',model:'m',stream:false,timeoutMs:1000},input:'再改一版',mode:'review',preferences:'',brief:'',history:[]};
    const revision=suggestionMessages(snapshot,suggestion,true)[0]!.content;
    expect(revision).toContain('只返回完整 JSON');expect(revision).not.toContain('本轮方式：讨论');expect(revision).not.toContain('不要输出改稿 JSON');
    expect(suggestionMessages(snapshot,suggestion,false)[0]!.content).toContain('本轮方式：讨论');
  });
});
describe('schema migration',()=>{
  it('backs up valid schema1 first, retaining edits and all prior structures',async()=>{
    const old=new Store(null,async()=>{}).data;old.version=1;delete old.dailyTopics;old.preferences='用户偏好';old.roles[0]!.systemPrompt='独立规则';
    const backup=vi.fn(async()=>{});const migrated=await Store.migrate(old,backup) as typeof old;
    expect(backup).toHaveBeenCalledOnce();expect(migrated.version).toBe(DATA_VERSION);expect(old.version).toBe(1);
    expect(new Store(migrated,async()=>{}).data.roles[0]!.systemPrompt).toBe('独立规则');expect(migrated.preferences).toBe('用户偏好');
  });
  it('does not migrate or persist if backup fails or old data is invalid',async()=>{
    const raw=new Store(null,async()=>{}).data;raw.version=1;delete raw.dailyTopics;
    await expect(Store.migrate(raw,async()=>{throw new Error('disk full');})).rejects.toThrow('disk full');expect(raw.version).toBe(1);
    const backup=vi.fn(async()=>{});await expect(Store.migrate({...raw,apiKey:'forbidden'},backup)).rejects.toThrow('未知字段');expect(backup).not.toHaveBeenCalled();
    expect(()=>new Store(raw,async()=>{})).toThrow('数据版本');
  });
  it('retains every legacy provider, custom role, candidate, and undo field after a byte-safe migration',async()=>{
    const owner=new Store(null,async()=>{});const old=owner.data;const session=owner.sessionFor({id:'legacy-doc',path:'旧稿.md',ctime:9});
    old.version=1;delete old.dailyTopics;old.providers=[{id:'p',name:'自定义连接',baseUrl:'https://api.example/v1',secretRef:'secret-reference-only',model:'custom-model',stream:false,timeoutMs:77,contextLimit:12345}];old.activeProviderId='p';
    old.roles[0]!.name='用户编辑的角色';old.roles[0]!.systemPrompt='完整自定义规则';old.roles[0]!.quickTasks=['任务 A'];old.preferences='完整偏好';
    session.brief='本文要求';session.messages.push({id:'m',role:'assistant',content:'旧讨论',at:1,status:'completed'});
    session.candidate={id:'candidate',requestId:'request',documentId:'legacy-doc',sessionId:session.id,path:'旧稿.md',scope:'selection',from:2,to:4,baseline:'前原句后',baselineHash:'stored-hash',replacement:'替换句',explanation:'说明',notes:['待核实'],state:'ready',deletion:false};
    session.undo={documentId:'legacy-doc',path:'旧稿.md',before:'前原句后',from:2,to:4,replacement:'替换句',candidateId:'candidate'};
    const original=structuredClone(old);let backedUp='';
    const migrated=await Store.migrate(old,async()=>{backedUp=JSON.stringify(old);}) as typeof old;
    expect(backedUp).toBe(JSON.stringify(original));expect(migrated.version).toBe(DATA_VERSION);expect(migrated.providers).toEqual(original.providers);expect(migrated.roles).toEqual(original.roles);expect(migrated.preferences).toBe('完整偏好');
    expect(migrated.sessions['legacy-doc']!.candidate).toEqual(original.sessions['legacy-doc']!.candidate);expect(migrated.sessions['legacy-doc']!.undo).toEqual(original.sessions['legacy-doc']!.undo);
    expect(old).toEqual(original);expect(new Store(migrated,async()=>{}).data.sessions['legacy-doc']!.candidate?.replacement).toBe('替换句');
  });
  it('strictly validates schema2 references and interrupts a running review',()=>{
    const store=new Store(null,async()=>{}),session=store.sessionFor({id:'d',path:'A.md',ctime:1}),r=ensureReview(session);
    r.runs.push({id:'r',requestId:'q',at:1,author:authorSnapshot(store.data.roles[0]!),model:'m',providerName:'p',snapshotHash:'x',scope:'body',status:'running',summary:'',overall:[],added:0,duplicates:0});
    expect(new Store(store.data,async()=>{}).data.sessions.d!.review!.runs[0]!.status).toBe('interrupted');
    expect(r.runs[0]!.status).toBe('running');
    expect(()=>new Store({...store.data,sessions:{d:{...session,review:{...r,secret:'forbidden'}}}},async()=>{})).toThrow('未知字段');
  });
  it('rejects cross-document receipts, unknown versions, and malformed persisted anchors before any save',()=>{
    const persist=vi.fn(async()=>{}),store=new Store(null,persist),session=store.sessionFor({id:'d',path:'A.md',ctime:1}),r=ensureReview(session),author=authorSnapshot(store.data.roles[0]!);
    r.runs.push({id:'run',requestId:'request',at:1,author,model:'m',providerName:'p',snapshotHash:'hash',scope:'body',status:'completed',summary:'',overall:[],added:1,duplicates:0});
    r.suggestions.push({id:'suggestion',documentId:'d',runId:'run',number:1,type:'表达',title:'标题',quote:'原句',contextBefore:'',contextAfter:'',author,versions:[{id:'version',at:1,author,reason:'说明',replacement:'新句',evidenceQuotes:[]}],currentVersionId:'version',state:'pending',fingerprint:'fp',replies:[]});
    r.receipts.push({id:'receipt',suggestionId:'suggestion',versionId:'version',documentId:'d',at:1,before:'原句',replacement:'新句',anchor:{from:0,to:2,text:'新句',valid:true},state:'applied',beforeHash:'b',afterHash:'a'});
    const badDocument=structuredClone(store.data);badDocument.sessions.d.review!.receipts[0]!.documentId='other';
    const badVersion=structuredClone(store.data);badVersion.sessions.d.review!.receipts[0]!.versionId='missing';
    const badAnchor=structuredClone(store.data);badAnchor.sessions.d.review!.receipts[0]!.anchor.to=1;
    expect(()=>new Store(badDocument,persist)).toThrow('撤回回执关联');expect(()=>new Store(badVersion,persist)).toThrow('撤回回执关联');expect(()=>new Store(badAnchor,persist)).toThrow('锚点长度');expect(persist).not.toHaveBeenCalled();
  });
});
