import {statSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import type {App,TFile} from 'obsidian';
/** Desktop filesystem metadata for an already-authorized TFile; no arbitrary paths/content are read. */
export function nativeFileIdentity(app:App,file:TFile):string | undefined {
  const adapter=app.vault.adapter as unknown as {getBasePath?:()=>string};
  if(!adapter?.getBasePath)return undefined;
  try {
    const root=adapter.getBasePath(),path=join(root,file.path),rel=relative(root,path);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))return undefined;
    const stat=statSync(path);if(!stat.isFile())return undefined;
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {return undefined;}
}
