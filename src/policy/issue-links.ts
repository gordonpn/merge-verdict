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
          token.replace(/[),.;!]+$/, ""),
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
  let comment = false;
  let inline = "";
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
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
      if (line[index] === "`") {
        const run = /^`+/.exec(line.slice(index))?.[0] ?? "`";
        if (inline === run) inline = "";
        else if (!inline) inline = run;
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
  return lines
    .join("\n")
    .replace(/!?\[[^\]]*\]\[[^\]]*\]/g, " ")
    .replace(
      /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*?\)))?\s*\)/g,
      (_match, destination: string) => ` ${destination} `,
    );
}
