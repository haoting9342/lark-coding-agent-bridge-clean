# Codex session recovery

The bridge automatically handles a narrow set of history compatibility errors
without archiving the conversation or creating a replacement thread.

Recovery is allowed only before the agent produces text or starts any tool
activity. The failed process must exit before the bridge repairs history or
starts another attempt. The retry resumes the thread ID reported by Codex with
the original prompt, model, attachments and execution options. A stop request
cancels recovery.

## History repairs

Only the profile's isolated `provider-codex-home` can be edited. Each repair kind
is attempted at most once per logical run:

- A rejected legacy `item_` ID can be removed from its response item.
- An `agent_message` containing a `c2a-msg-v1:` Base64 text envelope incorrectly
  stored as `encrypted_content` can be restored to `input_text`. The bridge
  requires a valid, lossless Base64 and UTF-8 round trip.

Repairs preserve rollout offsets, validate the full parsed record, create a
restricted-permission backup, verify SHA-256 hashes, and atomically replace the
file. Malformed or unsupported history is left unchanged. Real ciphertext and
encrypted compaction summaries are never erased or rewritten.

## Transient decryption failures

The following upstream errors allow up to two additional attempts, after delays
of one and two seconds:

- `Encrypted function output content could not be decrypted or decoded.`
- `The encrypted content for item cmp_... could not be verified. Reason:
  Encrypted content could not be decrypted or parsed.`

For a function-output error, the bridge first checks for the repairable text
envelope above. If no such content exists, it leaves history unchanged and uses
the bounded retry. A successful history repair can also be followed by transient
decryption retries in the same logical run. Retry exhaustion retains the
upstream error rather than inventing a successful outcome.

These limits apply to bridge retries in addition to any retries inside the Codex
CLI. Unrelated authentication, network and opaque-reasoning errors are not
classified as recoverable by this policy. Persistent upstream key or routing
incompatibilities still require investigation.

## Operations and verification

`agent.history-repaired`, `agent.history-repair-failed` and
`agent.decryption-retry` identify recovery decisions in the profile logs. A new
build must be loaded by restarting the running bridge before code changes take
effect; builds alone do not update a running Node process.

Regression coverage is in `tests/process/codex-decryption-recovery.test.ts`,
`tests/process/codex-history-recovery.test.ts`, and
`tests/unit/codex-history-repair.test.ts`. It covers recovery, bounded attempts,
opaque-history preservation, same-thread continuation, process serialization,
stop requests and the prohibition on replay after agent activity.
