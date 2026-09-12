

export type UploadCredentials={deviceId:string;token:string;origin:string};

export type Options = {
    fetch?: typeof fetch;
    now?: () => number;
    random?: () => number;
};
