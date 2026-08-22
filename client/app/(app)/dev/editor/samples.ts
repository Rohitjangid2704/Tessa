export const VALID_MANIFEST_SAMPLE = `target_token: tgt_ABCDEFGHIJKLMNOPQRSTUV
app:
  name: Gracie
  summary: Assistant that answers questions from hotel staff.
  kind: llm_assistant
interfaces:
  - id: chat_sse
    kind: sse
    base_path: /api/chat
features:
  - id: smart_log.read.open_maintenance
    area: Smart Log
    kind: read
    description: List maintenance issues that are still open
    interfaces: [chat_sse]
    roles: [all]
    examples:
      - ask: Which maintenance issues are still open?
        expected: count of open items from the oracle
    confidence: high
`;

export const INVALID_MANIFEST_SAMPLE = `target_token: not-a-token
app:
  name: Gracie
  kind: spaceship
interfaces: []
features: oops
`;
