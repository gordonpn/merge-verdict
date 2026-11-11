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
  let fence: string | undefined;
  const prose = (body ?? "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker?.[1] &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2]?.trim()
        )
          fence = undefined;
        return "";
      }
      if (marker?.[1]) {
        fence = marker[1];
        return "";
      }
      return /^(?: {4}|\t)/.test(line) ? "" : line;
    })
    .join("\n")
    .replace(/(`+)([\s\S]*?)\1(?!`)/g, " ")
    .replace(/!?\[[^\]]*\]\[[^\]]*\]/g, " ")
    .replace(
      /!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g,
      (_match, destination: string) => ` ${destination} `,
    );

  // Consume entire URLs first so their fragments cannot become local references.
  const tokens =
    /https?:\/\/[^\s<>]+|(?<![\w/.#-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+)?#[0-9]+(?![\w/.#-])/g;
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
