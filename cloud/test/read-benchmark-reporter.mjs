export default class ReadBenchmarkReporter {
  onTestCaseResult(testCase) {
    const benchmark=testCase.meta().readPerformance;
    if(benchmark)console.log('CLOUD_READ_BENCHMARK '+JSON.stringify(benchmark));
  }
}
