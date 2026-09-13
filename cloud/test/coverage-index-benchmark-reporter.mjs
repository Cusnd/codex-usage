export default class CoverageIndexBenchmarkReporter {
  onTestCaseResult(testCase) {
    const benchmark=testCase.meta().coverageIndexPerformance;
    if(benchmark)console.log('CLOUD_COVERAGE_INDEX_BENCHMARK '+JSON.stringify(benchmark));
  }
}
