import { jsonRequest } from './http.js';

export async function cloudRequest<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  return jsonRequest<T>(path,{method,signal,...body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}});
}
