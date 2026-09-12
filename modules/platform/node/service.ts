import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { dataRoot, packageRoot, version, port, instance, alive, control, delay } from "./runtime.js";

export async function ensureService() {
    const current = instance();
    if (current && alive(current.pid)) {
        if (current.port !== port || current.version !== version)
            throw new Error('Running service port/version differs. Stop it before restarting with this configuration.');
        for (let i = 0; i < 40; i++) {
            try {
                await control(current);
                return;
            }
            catch (error) {
                if (i === 39)
                    throw error;
                await delay(250);
            }
        }
    }
    mkdirSync(dataRoot, { recursive: true });
    const fd = openSync(path.join(dataRoot, 'service.log'), 'a');
    const child = spawn(process.execPath, [path.join(packageRoot, 'dist/apps/local/index.js')], {
        detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: process.env,
    });
    closeSync(fd);
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
        if (spawnError)
            throw spawnError;
        const record = instance();
        if (record) {
            try {
                await control(record);
                if (record.version !== version || record.port !== port)
                    throw new Error('Service configuration mismatch.');
                return;
            }
            catch (error) {
                if ((error as Error).message === 'Service configuration mismatch.')
                    throw error;
            }
        }
        await delay(200);
        if (child.exitCode !== null && !instance())
            break;
    }
    throw new Error(`Service failed to become ready. Port ${port} may be occupied. Inspect ${path.join(dataRoot, 'service.log')}.`);
}
