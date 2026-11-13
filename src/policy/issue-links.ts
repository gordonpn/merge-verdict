export interface IssueReference {
  repository: string | null;
  number: number;
}

/** Parse syntax only. The caller owns repository resolution and verdict publication. */
export function checkIssueLinks(body: string | null): {
  references: IssueReference[];
  failureMessage: string | null;
} {
  const references: IssueReference[] = [];
  const seen = new Set<string>();
  const prose = visibleMarkdown(body ?? "");

  // Consume entire URLs first so their fragments cannot become local references.
  const tokens =
    /https?:\/\/[^\s<>]+|(?<![\w/.#-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+)?#[0-9]+(?![\w/#-]|\.[0-9])/g;
  for (const match of prose.matchAll(tokens)) {
    const token = match[0];
    const target = token.startsWith("http")
      ? /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)(?:[?#][^\s]*)?$/.exec(
          token.replace(/[),.;!*_]+$/, ""),
        )
      : /^(?:(.+))?#([1-9][0-9]*)$/.exec(token);
    if (!target?.[2]) continue;
    const number = Number(target[2]);
    if (!Number.isSafeInteger(number)) continue;
    const repository = target[1] ?? null;
    const key = `${repository ?? ""}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ repository, number });
  }
  return {
    references,
    failureMessage: references.length
      ? null
      : "Add an issue reference to the PR description, for example Closes #123 or https://github.com/owner/repo/issues/123.",
  };
}

/** Mask code and comments in source order so syntax inside code stays passive. */
function visibleMarkdown(body: string): string {
  let fence: string | undefined;
  let fenceQuoteDepth = 0;
  let comment = false;
  let inline = "";
  const lines: string[] = [];
  const sourceLines = body.split(/\r?\n/);
  // Index matching delimiter runs once per paragraph, avoiding repeated suffix scans.
  const hasClosingRun = new Set<string>();
  const nextRuns = new Set<string>();
  for (let lineIndex = sourceLines.length - 1; lineIndex >= 0; lineIndex--) {
    const line = sourceLines[lineIndex] ?? "";
    if (!line.trim() || /^\s*(?:`{3,}|~{3,})/.test(line)) {
      nextRuns.clear();
      continue;
    }
    const runs = [...line.matchAll(/`+/g)];
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index];
      if (!run) continue;
      if (nextRuns.has(run[0])) hasClosingRun.add(`${lineIndex}:${run.index}`);
      nextRuns.add(run[0]);
    }
  }
  for (const [lineIndex, line] of sourceLines.entries()) {
    const quoteDepth = /^(?: {0,3}>[ \t]?)+/.exec(line)?.[0].split(">").length ?? 1;
    if (fence && quoteDepth - 1 < fenceQuoteDepth) fence = undefined;
    const marker = /^\s*(?:(?:[-+*]|[0-9]+[.)])\s+|>\s*)*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker?.[1] &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
      lines.push("");
      continue;
    }
    if (!comment && !inline && marker?.[1]) {
      fence = marker[1];
      fenceQuoteDepth = quoteDepth - 1;
      lines.push("");
      continue;
    }
    if (!comment && !inline && /^(?: {4}|\t)/.test(line)) {
      lines.push("");
      continue;
    }
    let visible = "";
    for (let index = 0; index < line.length; ) {
      if (comment) {
        const end = line.indexOf("-->", index);
        if (end < 0) break;
        comment = false;
        index = end + 3;
        continue;
      }
      if (
        !inline &&
        line[index] === "\\" &&
        /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(line[index + 1] ?? "")
      ) {
        visible += line[index + 1];
        index += 2;
        continue;
      }
      if (line[index] === "`") {
        const run = /^`+/.exec(line.slice(index))?.[0] ?? "`";
        if (inline === run) inline = "";
        else if (!inline) {
          // Unmatched delimiters are literal prose. A code span may cross lines,
          // but not a paragraph boundary or a fenced block.
          if (hasClosingRun.has(`${lineIndex}:${index}`)) {
            inline = run;
          } else {
            visible += run;
          }
        }
        visible += " ";
        index += run.length;
        continue;
      }
      if (inline) {
        index++;
        continue;
      }
      if (line.startsWith("<!--", index)) {
        comment = true;
        visible += " ";
        index += 4;
        continue;
      }
      visible += line[index];
      index++;
    }
    lines.push(visible);
  }
  const definitions = new Map<string, string>();
  const normalize = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
  const prose = lines
    .join("\n")
    .replace(
      /^ {0,3}\[([^\]]+)\]:[ \t]*(?:\n[ \t]*)?(<[^>]*>|[^\s]+)(?:(?:[ \t]+|\n[ \t]*)(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*?\)))?[ \t]*$/gm,
      (_match, label: string, destination: string) => {
        const key = normalize(label);
        if (!definitions.has(key)) definitions.set(key, destination);
        return "";
      },
    );
  return prose
    .replace(
      /!?\[([^\]]*)\]\[([^\]]*)\]/g,
      (_match, label: string, reference: string) =>
        ` ${definitions.get(normalize(reference || label)) ?? ""} `,
    )
    .replace(
      /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*?\)))?\s*\)/g,
      (_match, destination: string) => ` ${destination} `,
    );
}
