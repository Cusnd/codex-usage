import { open, type FileHandle } from 'node:fs/promises';

export type FramingMetrics = {bytes_read:number;max_line_bytes:number;trailing_bytes:number};
/** Bounded snapshot, complete UTF-8 JSONL records only. Segments keep long lines linear in memory copying. */
export async function* completeLines(file:string,start:number,end:number,options:{chunkBytes?:number;maxLineBytes?:number;metrics?:FramingMetrics;handle?:FileHandle}={}) {
  if(end<=start)return;
  const {chunkBytes=256*1024,maxLineBytes=64*1024*1024,metrics}=options;
  const handle=options.handle??await open(file,'r');let parts:Buffer[]=[],pending=0,position=start,readPosition=start;
  try {
    while(readPosition<end) {
      const buffer=Buffer.allocUnsafe(Math.min(chunkBytes,end-readPosition));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,readPosition);
      if(!bytesRead)throw Object.assign(Error('source shortened during bounded read'),{code:'SOURCE_CHANGED'});
      const chunk=buffer.subarray(0,bytesRead);readPosition+=bytesRead;if(metrics)metrics.bytes_read+=bytesRead;
      let offset=0,newline:number;
      while((newline=chunk.indexOf(10,offset))>=0) {
        const last=chunk.subarray(offset,newline+1),length=pending+last.length;
        if(length>maxLineBytes)throw Object.assign(Error('complete record exceeds supported byte limit'),{code:'LINE_TOO_LARGE',position});
        const bytes=parts.length?Buffer.concat([...parts,last],length):last;
        if(metrics)metrics.max_line_bytes=Math.max(metrics.max_line_bytes,length);
        yield {bytes,start:position,end:position+length};position+=length;parts=[];pending=0;offset=newline+1;
      }
      if(offset<chunk.length){parts.push(chunk.subarray(offset));pending+=chunk.length-offset;}
      if(pending>maxLineBytes)throw Object.assign(Error('unfinished record exceeds supported byte limit'),{code:'LINE_TOO_LARGE',position});
    }
    if(metrics)metrics.trailing_bytes+=pending;
  } finally {if(!options.handle)await handle.close();}
}
