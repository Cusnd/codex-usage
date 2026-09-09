import type { ExecFileOptions } from 'node:child_process';
export function captureProcess(file: string, args: string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }>;
