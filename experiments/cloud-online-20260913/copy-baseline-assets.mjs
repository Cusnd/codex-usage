// Run only after the final candidate build. Never modifies the baseline directory.
import { readFile, readdir, mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const base = path.resolve('artifacts/cloud-experience/after');
const candidate = path.resolve('artifacts/cloud-online-20260913/build');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const baselineHTML = await readFile(path.join(base, 'index.html'));
if (digest(baselineHTML) !== '02f71250bbb39a35f1a00b72f68933963213c5c669142edcbbd21afe8d72b4ce') throw new Error('Baseline HTML fingerprint changed.');
const baselineEntry = await readFile(path.join(base, 'assets/index-Dfn7gbQe.js'));
if (digest(baselineEntry) !== '150f8277637f20e57fa7b3a9b3846df4222618f9927ba90146905b2f3419c58a') throw new Error('Baseline entry fingerprint changed.');
const candidateHTML = await readFile(path.join(candidate, 'index.html'));
if (candidateHTML.includes(Buffer.from('index-Dfn7gbQe.js'))) throw new Error('Candidate directory points to baseline.');
await mkdir(path.join(candidate, 'assets'), { recursive: true });
const rows = [];
for (const name of await readdir(path.join(base, 'assets'))) {
  if (name === 'cache-checks.js') continue; // Prior standalone IDB harness is not an application dependency.
  const source = path.join(base, 'assets', name), target = path.join(candidate, 'assets', name);
  if (!(await stat(source)).isFile()) throw new Error('Unexpected non-file baseline asset.');
  const bytes = await readFile(source), hash = digest(bytes);
  let existing;
  try { existing = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && digest(existing) !== hash) throw new Error('Candidate asset collision with different content: ' + name);
  if (!existing) await copyFile(source, target);
  rows.push({ file: 'assets/' + name, bytes: bytes.length, sha256: hash, action: existing ? 'identical-shared-asset' : 'copied-baseline-only' });
}
const result = { at: new Date().toISOString(), baseline: base, candidate, baselineHTMLSha256: digest(baselineHTML), candidateHTMLSha256: digest(candidateHTML), rows,
  note: 'Baseline source is read-only. Copied baseline-only assets must not count as candidate bundle size. Re-run after each candidate build that empties output.' };
await writeFile('artifacts/cloud-online-20260913/baseline-assets.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
