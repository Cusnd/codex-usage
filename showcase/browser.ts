import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { ExampleStore } from './store';
import { createExampleAdapter, type SettingsStorage } from './adapter';

let instance: Promise<ReturnType<typeof createExampleAdapter>> | undefined;
export function exampleAdapter() {
  return instance ??= initSqlJs({ locateFile: () => wasmUrl }).then(SQL => {
    let storage: SettingsStorage | undefined;
    try { storage = window.localStorage; } catch {
      storage = {getItem: () => null, setItem: () => { throw new Error('浏览器禁止保存设置，请允许本站使用本地存储后重试。'); }};
    }
    return createExampleAdapter(new ExampleStore(SQL), storage);
  }).catch(error => { instance = undefined; throw error; });
}
