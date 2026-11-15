export interface DiffCoverageResult {
  totalLines: number;
  coveredLines: number;
  percentage: number;
  passed: boolean;
  uncoveredByFile: Record<string, number[]>;
}

export interface RunCliOptions {
  lcovPath?: string;
  threshold?: number;
  baseRef?: string;
  execDiff?: (ref: string) => string;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

export function parseLcov(lcovText: string, rootDir?: string): Map<string, Map<number, number>>;
export function parseUnifiedDiff(diffText: string): Map<string, Set<number>>;
export function evaluateDiffCoverage(input: {
  lcovMap: Map<string, Map<number, number>>;
  diffMap: Map<string, Set<number>>;
  threshold?: number;
}): DiffCoverageResult;
export function runCli(options?: RunCliOptions): void;
