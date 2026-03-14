export type TestResult = {
  name: string;
  passed: boolean;
  error?: string;
};

function splitSeriesName(name: string): { series: string | null; detail: string } {
  const match = /^([A-Z]+\d+):\s*(.*)$/.exec(name);
  if (!match) {
    return { series: null, detail: name };
  }
  return {
    series: match[1],
    detail: match[2],
  };
}

export function formatSeriesResult(result: TestResult): string {
  const { series, detail } = splitSeriesName(result.name);
  const status = result.passed ? "PASS" : "FAIL";
  const prefix = series ? `${series}: ${status}` : `${status}: ${result.name}`;
  const suffix = detail && series ? ` - ${detail}` : "";
  const error = result.error ? ` — ${result.error}` : "";
  return `${prefix}${suffix}${error}`;
}

export function printSeriesResults(results: readonly TestResult[]): { passed: number; failed: number } {
  let passed = 0;
  for (const result of results) {
    if (result.passed) {
      passed += 1;
      console.log(`  ${formatSeriesResult(result)}`);
    } else {
      console.error(`  ${formatSeriesResult(result)}`);
    }
  }
  return { passed, failed: results.length - passed };
}

export function printSeriesSummary(results: readonly TestResult[]): { passed: number; failed: number } {
  const summary = printSeriesResults(results);
  console.log(`\n${summary.passed} passed, ${summary.failed} failed out of ${results.length}`);
  return summary;
}

export function exitForSeriesResults(results: readonly TestResult[]): void {
  const { failed } = printSeriesSummary(results);
  process.exit(failed > 0 ? 1 : 0);
}

export function failSeriesRun(error: unknown): never {
  console.error("Test runner fatal:", error);
  process.exit(1);
}
