import base from '../../cloud/vitest.config.ts';

export default async()=>{
  const config=await (base as ()=>Promise<any>)();
  return {...config,test:{...config.test,
    include:['../experiments/cloud-online-20260913/cleanup-probe.test.ts'],
    reporters:['default','../experiments/cloud-online-20260913/cleanup-reporter.mjs'],
  }};
};
