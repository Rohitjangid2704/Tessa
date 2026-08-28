# WebSocket echo fixture bundle

Bundle of the Tessa websocket fixture (`deploy/fixtures/adapters/ws_echo`), used to exercise the `websocket` adapter.

## What is here

- `manifest.yaml`: one `websocket` interface (`echo_ws`, base path `/ws`), one role (`member`), four features, the environment and the test hooks.
- `env.template`: the two variables Tessa needs, placeholders only.
- `scenarios/`: five scenarios, three expected to pass and one pair that shows a deliberate failure.

## Scenarios and expected verdicts

| Scenario | Expected |
|---|---|
| `ws-echo-roundtrip` | pass |
| `ws-subscribe-room` | pass |
| `ws-anonymous-refused` | pass (close code 1008 is what the scenario asks for) |
| `ws-poison-closes-with-1008` | pass |
| `ws-poison-expected-healthy-fails` | fail by design (the server closes with 1008 after the poisoned message) |

## Values

Set `WS_ECHO_URL` to the origin of the running fixture, for example `ws://127.0.0.1:8520`, and `WS_ECHO_TOKEN` to the token the fixture was started with (see the fixture README, development value only).
