import { spawn } from "node:child_process";
import { browserCommand } from "./platform.js";

export async function openBrowser(url: string) {
    const { command, args, wait } = browserCommand(url);
    const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, ...(wait ? { timeout: 15000 } : {}) });
    await new Promise<void>((resolve, reject) => {
        opener.once('error', reject);
        if (wait)
            opener.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
        else
            opener.once('spawn', resolve);
    });
    opener.unref();
}
