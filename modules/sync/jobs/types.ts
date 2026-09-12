

export type Job={user_id:string;job_id:string;kind:string;device_id:string|null;state:string;payload:string;checkpoint:string;lease_token:string;lease_until:number;attempts:number;next_attempt_at:number};
