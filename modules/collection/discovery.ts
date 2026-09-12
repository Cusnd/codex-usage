import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function discoverSources(root:string) {
    const files:{file:string;priority:number}[]=[];
    const visit=async(dir:string)=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')return;throw e;}
      for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isDirectory())await visit(file);else if(entry.isFile()&&file.endsWith('.jsonl')){try{files.push({file,priority:(await stat(file)).mtimeMs});}catch(e:any){if(e.code!=='ENOENT')throw e;}}}};
    await visit(path.join(root,'sessions'));await visit(path.join(root,'archived_sessions'));
    const title=path.join(root,'session_index.jsonl');try{files.push({file:title,priority:(await stat(title)).mtimeMs});}catch(e:any){if(e.code!=='ENOENT')throw e;}

  return files;
}
