export default class PublicationBenchmarkReporter {
  onTestCaseResult(testCase) {
    const benchmark=testCase.meta().publicationBenchmark;
    if(benchmark)console.log('CLOUD_PUBLICATION_BENCHMARK '+JSON.stringify(benchmark));
  }
}
