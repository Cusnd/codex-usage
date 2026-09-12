import { type AccountSource } from "../../modules/accounts/reader.js";

export type LocalAppOptions = {
    database?: string;
    codexHome?: string;
    startup?: boolean;
    logger?: boolean;
    accountReader?: AccountSource;
    exampleData?: boolean;
    cloudCredentialFile?: string | null;
    cloudOrigin?: string;
    cloudFetch?: typeof fetch;
    managed?: { token: string; version: string; shutdown: () => Promise<void> };
  };
