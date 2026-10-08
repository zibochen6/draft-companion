import assert from 'node:assert/strict';
export async function connectDesktop(port,title) {
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const page=pages.find(p=>p.url==='app://obsidian.md/index.html'&&p.title.includes(title));assert(page,'Expected vault window');
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let sequence=0;const pending=new Map();
 ws.addEventListener('message',event=>{const v=JSON.parse(event.data),entry=pending.get(v.id);if(!entry)return;pending.delete(v.id);clearTimeout(entry.timer);v.error?entry.reject(new Error('Desktop protocol error')):entry.resolve(v.result);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Desktop action timeout'));},55000)});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const v=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw new Error('Controlled desktop assertion failed; raw private diagnostics are suppressed.');return v.result.value;};
 return {call,evaluate,close:()=>{for(const e of pending.values())clearTimeout(e.timer);ws.close();}};
}
