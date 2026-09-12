import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Credentials = {
    origin: string;
    token: string;
    requestId?: string;
    pollSecret?: string;
};

export function writeCredentials(file:string|null,c:Credentials|null) {


    if (file) {
      if (c) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file + ".tmp", JSON.stringify(c), { mode: 0o600 });
        renameSync(file + ".tmp", file);
      } else if (existsSync(file)) unlinkSync(file);
    }


}
