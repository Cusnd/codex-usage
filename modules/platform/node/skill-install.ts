import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { copyDirectory } from "./copy-directory.js";
import { packageRoot } from "./runtime.js";

export function skill(action: string) {
    const root = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const target = path.join(root, 'skills/codex-usage');
    const marker = path.join(target, '.codex-usage-managed');
    if (existsSync(target) && (!existsSync(marker) || readFileSync(marker, 'utf8') !== 'codex-detailed-usage\n'))
        throw new Error('Unmanaged codex-usage Skill exists; preserve it and resolve the conflict first.');
    if (!['install', 'uninstall'].includes(action))
        throw new Error('Use skill install|uninstall.');
    if (existsSync(target)) {
        const backup = path.join(root, 'codex-usage-skill-backups', String(Date.now()));
        mkdirSync(path.dirname(backup), { recursive: true });
        renameSync(target, backup);
    }
    if (action === 'install') {
        mkdirSync(target, { recursive: true });
        copyDirectory(path.join(packageRoot, 'skills/codex-usage'), target);
        writeFileSync(marker, 'codex-detailed-usage\n');
        writeFileSync(path.join(target, '.codex-usage-cli.json'), JSON.stringify({ node: process.execPath, cli: path.join(packageRoot, 'bin/codex-usage.mjs') }));
    }
    return { action, path: target };
}
