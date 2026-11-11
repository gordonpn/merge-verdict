# PR body issue references

The pure `checkIssueLinks` function in `src/policy/issue-links.ts` returns syntactic references and a nullable actionable failure message. Local references have a null repository; qualified references retain the supplied owner/repository. Repeated identical targets appear once in encounter order. Closing keywords are accepted as ordinary prose surrounding a reference.

Fenced and indented code, inline code, HTML comments, invalid issue numbers, and unrelated URLs do not count. Markdown links are inspected by destination, so misleading labels cannot satisfy the check. Positive safe integer issue numbers use their canonical decimal spelling.

This is a standalone building block for issue #57. The collector still needs to collect the PR body, and the evaluator must call this function and turn a missing reference into a blocking verdict. It does not publish checks or reviews.

Product decisions remain open: whether targets must exist and be open, whether GitHub PR targets should be rejected through API lookup, whether cross-repository targets need restrictions, and whether configuration or label exemptions should be supported. No network validation or exemptions are implemented.
