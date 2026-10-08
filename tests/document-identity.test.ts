import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeFileIdentity} from '../src/document-identity';
import {Documents} from '../src/documents';
import {Store} from '../src/store';
import {TFile,MarkdownView,TestEditor} from './obsidian-mock';
import type {App,WorkspaceLeaf} from 'obsidian';
function environment(root:string,file:TFile) {
 const leaf={view:new MarkdownView(file,new TestEditor('原句'))};
 const app={vault:{adapter:{getBasePath:()=>root},getAbstractFileByPath:(path:string)=>path===file.path?file:undefined},workspace:{getLeavesOfType:()=>[leaf],getMostRecentLeaf:()=>leaf}} as unknown as App;
 return{app,leaf};
}
describe('desktop persistent document identity',()=>{
 it('does not inherit a candidate or undo after an offline same-path/ctime rebuild',()=>{
  const root=mkdtempSync(join(tmpdir(),'draft-companion-identity-'));try{
   writeFileSync(join(root,'A.md'),'原句');const original=new TFile('A.md'),oldEnv=environment(root,original),store=new Store(null,async()=>{});
   const nativeId=nativeFileIdentity(oldEnv.app,original)!;expect(nativeId).toBeTruthy();
   const s=store.sessionFor({id:'old-document',path:'A.md',ctime:1,nativeId});s.messages=[{id:'history',role:'user',content:'原来的讨论保留',at:1}];
   s.candidate={id:'c',requestId:'r',documentId:s.document.id,sessionId:s.id,path:'A.md',scope:'body',from:0,to:2,baseline:'原句',baselineHash:'h',replacement:'旧候选',explanation:'',notes:[],state:'ready',deletion:false};s.undo={documentId:s.document.id,path:'A.md',before:'原句',from:0,to:2,replacement:'新句',candidateId:'c'};
   unlinkSync(join(root,'A.md'));writeFileSync(join(root,'A.md'),'原句');const rebuilt=new TFile('A.md'),next=environment(root,rebuilt);
   expect(nativeFileIdentity(next.app,rebuilt)).not.toBe(nativeId);const docs=new Documents(next.app,store.data.sessions);docs.focus(next.leaf as unknown as WorkspaceLeaf);
   expect(docs.current()?.id).not.toBe(s.document.id);expect(()=>docs.resolve(s.document.id)).toThrow();expect(s.candidate.state).toBe('stale');expect(s.undo.needsCheck).toBe(true);expect(s.messages[0]?.content).toBe('原来的讨论保留');
  } finally{rmSync(root,{recursive:true,force:true});}
 });
 it('legacy associations keep history but do not silently trust old writes without a live handoff',()=>{
  const root=mkdtempSync(join(tmpdir(),'draft-companion-identity-'));try{
   writeFileSync(join(root,'A.md'),'原句');const file=new TFile('A.md'),env=environment(root,file),store=new Store(null,async()=>{}),s=store.sessionFor({id:'legacy',path:'A.md',ctime:1});
   s.undo={documentId:'legacy',path:'A.md',before:'原句',from:0,to:2,replacement:'新句',candidateId:'c'};new Documents(env.app,store.data.sessions);expect(s.undo.needsCheck).toBe(true);expect(s.document.nativeId).toBeTruthy();
   delete s.undo.needsCheck;delete s.document.nativeId;new Documents(env.app,store.data.sessions,new Map([['legacy',file]]));expect(s.undo.needsCheck).toBeUndefined();expect(s.document.nativeId).toBeTruthy();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
