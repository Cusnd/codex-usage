// Preserve repeated deviceIds when moving between list, detail and full-session scopes.
export function navigationSearch(current: string | URLSearchParams, patch: Record<string,string> = {}, devicesOnly=false) {
  const original=new URLSearchParams(current),next=devicesOnly?new URLSearchParams():new URLSearchParams(original);
  if(devicesOnly)original.getAll('deviceIds').forEach(id=>next.append('deviceIds',id));
  for(const [key,value] of Object.entries(patch))next.set(key,value);
  return next.toString();
}
