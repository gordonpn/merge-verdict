/**
 * Strips leading and trailing Markdown formatting punctuation and whitespace from a string.
 *
 * @param str Input line text.
 * @returns Cleaned string without leading or trailing markdown formatting characters.
 */
export function stripMarkdownPunctuation(str: string): string {
  let start = 0;
  let end = str.length;
  const punctuation = new Set(["_", "*", "~", "`", "#", ">", "-", " ", "\t", "\r", "\n"]);
  while (start < end) {
    const char = str[start];
    if (char && punctuation.has(char)) {
      start++;
    } else {
      break;
    }
  }
  while (end > start) {
    const char = str[end - 1];
    if (char && punctuation.has(char)) {
      end--;
    } else {
      break;
    }
  }
  return str.slice(start, end);
}
