import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TRACKED_PREFIXES = ["src/"];
const TRACKED_EXTENSIONS = [".ts"];

function isTrackedSourcePath(path) {
  return (
    TRACKED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
    TRACKED_EXTENSIONS.some((ext) => path.endsWith(ext)) &&
    !path.endsWith(".d.ts")
  );
}

/**
 * Parse LCOV content into a map of relative file paths to line hit counts.
 * @param {string} lcovText
 * @param {string} [rootDir]
 * @returns {Map<string, Map<number, number>>}
 */
export function parseLcov(lcovText, rootDir = process.cwd()) {
  const files = new Map();
  let currentFile = null;
  const resolvedRoot = resolve(rootDir).replace(/\\/g, "/");

  for (const rawLine of lcovText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      let path = line.slice(3).replace(/\\/g, "/");
      if (path.startsWith(`${resolvedRoot}/`)) {
        path = path.slice(resolvedRoot.length + 1);
      } else if (path.startsWith("./")) {
        path = path.slice(2);
      }
      currentFile = path;
      if (!files.has(currentFile)) {
        files.set(currentFile, new Map());
      }
    } else if (line.startsWith("DA:") && currentFile) {
      const [lineNumStr, hitsStr] = line.slice(3).split(",");
      const lineNum = Number.parseInt(lineNumStr, 10);
      const hits = Number.parseInt(hitsStr, 10);
      if (Number.isFinite(lineNum) && Number.isFinite(hits)) {
        files.get(currentFile).set(lineNum, hits);
      }
    } else if (line === "end_of_record") {
      currentFile = null;
    }
  }
  return files;
}

/**
 * Decode Git's C-style quoted filename, including octal-escaped UTF-8 bytes.
 * @param {string} path
 * @returns {string}
 */
function unquoteGitPath(path) {
  if (!path.startsWith('"')) return path;
  const escapes = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  const chunks = [];
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; ) {
    if (body[i] === "\\") {
      const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (octal) {
        chunks.push(Buffer.from([Number.parseInt(octal[0], 8)]));
        i += 4;
      } else {
        const escaped = body[i + 1];
        chunks.push(Buffer.from(escapes[escaped] ?? escaped));
        i += 2;
      }
    } else {
      const character = String.fromCodePoint(body.codePointAt(i));
      chunks.push(Buffer.from(character));
      i += character.length;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse unified git diff (-U0) into a map of tracked source files to added/modified line numbers.
 * @param {string} diffText
 * @returns {Map<string, Set<number>>}
 */
export function parseUnifiedDiff(diffText) {
  const changed = new Map();
  let currentFile = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      oldRemaining = 0;
      newRemaining = 0;
      continue;
    }

    if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith("+")) {
        newRemaining = Math.max(0, newRemaining - 1);
        continue;
      }
      if (line.startsWith("-")) {
        oldRemaining = Math.max(0, oldRemaining - 1);
        continue;
      }
      if (line.startsWith(" ")) {
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
        continue;
      }
      if (line.startsWith("\\")) {
        continue;
      }
      oldRemaining = 0;
      newRemaining = 0;
    }

    if (line.startsWith("+++ ")) {
      const destination = unquoteGitPath(line.slice(4));
      const path = destination.startsWith("b/") ? destination.slice(2) : "";
      currentFile = isTrackedSourcePath(path) ? path : null;
      if (currentFile && !changed.has(currentFile)) {
        changed.set(currentFile, new Set());
      }
    } else if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      oldRemaining = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
      newRemaining = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
      if (!currentFile) continue;
      const start = Number.parseInt(match[3], 10);
      const lineSet = changed.get(currentFile);
      for (let i = 0; i < newRemaining; i += 1) {
        lineSet.add(start + i);
      }
    }
  }
  return changed;
}

/**
 * Evaluate diff line coverage against LCOV data.
 * @param {{ lcovMap: Map<string, Map<number, number>>, diffMap: Map<string, Set<number>>, threshold?: number }} input
 * @returns {{ totalLines: number, coveredLines: number, percentage: number, passed: boolean, uncoveredByFile: Record<string, number[]> }}
 */
export function evaluateDiffCoverage({ lcovMap, diffMap, threshold = 85 }) {
  let totalLines = 0;
  let coveredLines = 0;
  const uncoveredByFile = {};

  for (const [filePath, changedLines] of diffMap.entries()) {
    const fileCoverage = lcovMap.get(filePath);
    if (!fileCoverage) {
      if (changedLines.size > 0) {
        const sorted = Array.from(changedLines).sort((a, b) => a - b);
        totalLines += sorted.length;
        uncoveredByFile[filePath] = sorted;
      }
      continue;
    }

    const uncovered = [];
    for (const lineNum of changedLines) {
      if (!fileCoverage.has(lineNum)) {
        continue;
      }
      totalLines += 1;
      if (fileCoverage.get(lineNum) > 0) {
        coveredLines += 1;
      } else {
        uncovered.push(lineNum);
      }
    }
    if (uncovered.length > 0) {
      uncoveredByFile[filePath] = uncovered.sort((a, b) => a - b);
    }
  }

  const percentage = totalLines === 0 ? 100 : (coveredLines / totalLines) * 100;
  return {
    totalLines,
    coveredLines,
    percentage,
    passed: percentage >= threshold,
    uncoveredByFile,
  };
}

/**
 * Execute the diff coverage CLI against an LCOV report and git diff.
 * @param {{ lcovPath?: string, threshold?: number, baseRef?: string, execDiff?: (ref: string) => string, exit?: (code: number) => void, log?: (msg: string) => void, error?: (msg: string) => void }} [options]
 */
export function runCli({
  lcovPath = process.env.LCOV_PATH ?? "coverage/lcov.info",
  threshold = Number.parseFloat(process.env.DIFF_COVERAGE_MIN ?? "85"),
  baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main",
  execDiff = (ref) =>
    execFileSync("git", ["diff", "-U0", "--diff-filter=AMR", `${ref}...HEAD`], {
      encoding: "utf8",
    }),
  exit = (code) => process.exit(code),
  log = console.log,
  error = console.error,
} = {}) {
  if (!existsSync(lcovPath)) {
    error(`Diff coverage check failed: missing LCOV file at ${lcovPath}`);
    exit(1);
    return;
  }

  const lcovText = readFileSync(lcovPath, "utf8");
  const diffText = execDiff(baseRef);

  const lcovMap = parseLcov(lcovText);
  const diffMap = parseUnifiedDiff(diffText);
  const result = evaluateDiffCoverage({ lcovMap, diffMap, threshold });

  log(
    `Diff coverage: ${result.coveredLines}/${result.totalLines} lines (${result.percentage.toFixed(2)}%, threshold ${threshold}%)`,
  );

  if (!result.passed) {
    error("Uncovered diff lines:");
    for (const [file, lines] of Object.entries(result.uncoveredByFile)) {
      error(`  ${file}: ${lines.join(", ")}`);
    }
    exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
