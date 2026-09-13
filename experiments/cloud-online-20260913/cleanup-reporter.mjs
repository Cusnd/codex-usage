import fs from 'node:fs';
import path from 'node:path';
export default class CleanupReporter {
  onTestCaseResult(testCase){
    const evidence=testCase.meta().cleanupEvidence;
    if(!evidence)return;
    const directory=path.resolve('../artifacts/cloud-online-20260913/cleanup');fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({at:new Date().toISOString(),...evidence},null,2));
    console.log('CLEANUP_SCAN_EVIDENCE '+JSON.stringify(evidence));
  }
}
