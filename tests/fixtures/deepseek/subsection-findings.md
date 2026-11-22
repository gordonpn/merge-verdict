## Verdict

**{{verdict}}**

## Material Findings

### 1. MEDIUM - Missing boundary guard

The input crosses a trust boundary without validation.

#### Verification detail

- Reject malformed input.
- Preserve the error result.

### 2. LOW - Clarify the diagnostic

Describe the rejected input without exposing its value.

{{boundary}}

- This belongs to the next section.

### 3. HIGH - Outside material findings

This must never appear in findings.
