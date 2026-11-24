import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ReviewTarget {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly runId: number;
  readonly runAttempt: number;
}

interface PostingEvidence {
  readonly schema_version: 2;
  readonly workflow_path: ".github/workflows/pr-agent.yml";
  readonly run_id: number;
  readonly run_attempt: number;
  readonly repository: string;
  readonly pull_request_number: number;
  readonly head_sha: string;
  readonly comment_id: number;
  readonly body_digest: string;
}

const STATE_MARKER = "<!-- pr-agent-review-state:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function hasMatchingPersistentState(markdown: string, headSha: string): boolean {
  const start = markdown.indexOf(STATE_MARKER);
  if (start < 0) return false;

  const jsonStart = skipWhitespace(markdown, start + STATE_MARKER.length);
  if (markdown[jsonStart] !== "{") return false;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonEnd = -1;
  for (let i = jsonStart; i < markdown.length; i += 1) {
    const ch = markdown[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd < 0) return false;

  const afterJson = skipWhitespace(markdown, jsonEnd);
  if (!markdown.startsWith("-->", afterJson)) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(markdown.slice(jsonStart, jsonEnd));
  } catch {
    return false;
  }

  return (
    isRecord(parsed) &&
    parsed.schema_version === 1 &&
    isRecord(parsed.last_run) &&
    typeof parsed.last_run.complete === "boolean" &&
    typeof parsed.last_run.head_sha === "string" &&
    parsed.last_run.head_sha.toLowerCase() === headSha.toLowerCase() &&
    Array.isArray(parsed.findings)
  );
}

/** Publishes one generated review and returns evidence from its exact posting receipt. */
export async function publishGeneratedReview(
  text: string,
  target: ReviewTarget,
  post: (body: string) => Promise<unknown>,
): Promise<PostingEvidence> {
  const output: unknown = JSON.parse(text);
  if (
    !isRecord(output) ||
    output.type !== "review" ||
    !isRecord(output.pr) ||
    output.pr.provider !== "github" ||
    output.pr.repo !== target.repository ||
    output.pr.number !== target.pullRequestNumber ||
    output.pr.head_sha !== target.headSha ||
    typeof output.markdown !== "string" ||
    output.markdown.trim() === ""
  ) {
    throw new Error("Expected one generated review for the captured repository, PR, and head");
  }

  if (!hasMatchingPersistentState(output.markdown, target.headSha)) {
    throw new Error(
      "Generated PR-Agent review is missing valid persistent finding state for the captured head",
    );
  }

  const envelope = readFileSync(new URL("./pr-agent-review-envelope.md", import.meta.url), "utf8")
    .replace("{{repository}}", target.repository)
    .replace("{{head_sha}}", target.headSha);
  const body = `${envelope.trimEnd()}\n\n${output.markdown}`;
  const receipt = await post(body);
  if (
    !isRecord(receipt) ||
    typeof receipt.id !== "number" ||
    !Number.isSafeInteger(receipt.id) ||
    receipt.id <= 0 ||
    receipt.body !== body
  ) {
    throw new Error("GitHub did not return a matching comment posting receipt");
  }

  return {
    schema_version: 2,
    workflow_path: ".github/workflows/pr-agent.yml",
    run_id: target.runId,
    run_attempt: target.runAttempt,
    repository: target.repository,
    pull_request_number: target.pullRequestNumber,
    head_sha: target.headSha,
    comment_id: receipt.id,
    body_digest: createHash("sha256").update(body).digest("hex"),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const headSha = requiredEnv("HEAD_SHA");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(headSha)) {
    throw new Error("Invalid repository or head SHA");
  }
  const target: ReviewTarget = {
    repository,
    headSha,
    pullRequestNumber: positiveInteger("PR_NUMBER"),
    runId: positiveInteger("GITHUB_RUN_ID"),
    runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT"),
  };
  const text = readFileSync(requiredEnv("PR_AGENT_OUTPUT_PATH"), "utf8");
  const provenancePath = requiredEnv("PROVENANCE_PATH");
  const currentHead = execFileSync(
    "gh",
    ["api", `repos/${repository}/pulls/${target.pullRequestNumber}`, "--jq", ".head.sha"],
    { encoding: "utf8" },
  ).trim();
  if (currentHead !== headSha) {
    throw new Error("PR head changed during review; refusing to publish obsolete evidence");
  }

  const evidence = await publishGeneratedReview(text, target, async (body) => {
    const response = execFileSync(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/issues/${target.pullRequestNumber}/comments`,
        "--input",
        "-",
      ],
      { input: JSON.stringify({ body }), encoding: "utf8" },
    );
    const receipt: unknown = JSON.parse(response);
    return receipt;
  });
  writeFileSync(provenancePath, JSON.stringify(evidence));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
