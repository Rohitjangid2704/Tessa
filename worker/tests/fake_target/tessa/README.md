# Fake target test bundle

Bundle of the Tessa fake target (`worker/tests/fake_target`), a tiny hotel assistant with an in-memory dataset. It is used by the worker tests, the end to end runs and the gate: it validates with the real bundle validator and uploads through the real intake.

## What is here

- `manifest.yaml`: three interfaces (`chat_sse` stream, `api` REST, `browser`), three roles, six features with examples, invariants and the environment.
- `env.template`: the variables Tessa needs, placeholders only.
- `flows/`: `login_and_chat` and `confirm_create_issue` for the browser adapter.
- `seeds/`: reset and hash scripts that call the QA hooks `POST /qa/reset` and `GET /qa/hash`.

## Accounts and values (development only)

The values are the constants in `worker/tests/fake_target/dataset.py`: staff email `staff@fake.test` with a password, and fixed manager and admin tokens. Set them in the target environment after uploading the bundle.
