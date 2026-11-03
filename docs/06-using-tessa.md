# 6. Using Tessa

This guide walks through testing your own app in the web app, from the first target to the first findings. [Guide 7](07-claude-code.md) shows how Claude Code does most of these steps for you.

## The words Tessa uses

| Word | Meaning |
|---|---|
| **Target** | an app you test, for example "Shop API (QA)" |
| **Bundle** | the `tessa/` folder that describes a target: its features, roles, interfaces, environment variables, seeds, reference queries and UI flows. Claude Code writes it from your repo, and you upload it as a zip |
| **Catalog** | what Tessa can test, built from the bundle: features × roles × depth |
| **Plan** | the cells of the catalog you picked |
| **Scenario** | one test: a list of steps (`http`, `sse`, `browser`, `websocket`, `graphql`) with expectations |
| **Run** | one execution of a plan or of some scenarios, with a hard budget in dollars and minutes |
| **Verdict** | the outcome of a step: pass, fail or uncertain, with the tier that decided it (code, Laya, judge or human) and a confidence |
| **Finding** | a de-duplicated failure with its repro, transcript and screenshots |
| **Seed** | the script that puts the test data in a known state before a run |
| **Oracle** | a read-only SQL query against your app's database that gives the true answer a step is checked against |

## Step 1: Create a target

Targets, New target. Give it a name and say what kind of app it is. Tessa gives the target a `target_token`, which goes into the bundle so a bundle can never be uploaded to the wrong target.

Use a **QA or local deployment** of your app, never production. Tessa refuses URLs that match `TESSA_PRODUCTION_URL_PATTERNS`.

## Step 2: Get a bundle from Claude Code

On the target page, open the **Discovery prompt** and copy it. Then:

1. Open the repository of your app in your editor with Claude Code, or run `claude` in that folder.
2. Paste the prompt.
3. Claude Code reads the code and writes a `tessa/` folder in your repo, with:
   - `manifest.yaml`: the app, its interfaces (HTTP, browser and so on), roles, features with examples, and environment variables,
   - `README.md`: a plain-language description for QA,
   - `env.template`: the variable names with comments, never real values,
   - optionally seeds, oracles (SQL) and UI flows.
4. Zip the `tessa/` folder.

With the plugin, `/tessa:discover` does all of this and uploads the bundle for you (see [guide 7](07-claude-code.md)).

A minimal manifest looks like this:

```yaml
schema: http://localhost:8000/schemas/bundle.v1.json
target_token: tgt_...
app:
  name: Notes API
  summary: A small notes service with a JSON API.
  kind: api
interfaces:
  - id: notes_http
    kind: http
    base_path: /api
    health_endpoint: /health
roles:
  - id: anonymous
    level: 0
    description: Anyone, no login
features:
  - id: notes.read.list
    area: Notes
    kind: read
    description: List all notes
    interfaces: [notes_http]
    roles: [all]
    examples:
      - request: { method: GET, path: /api/notes }
        expected: A JSON array of notes, newest first
environment:
  - name: NOTES_BASE_URL
    kind: url
    secret: false
    required: true
    purpose: Base URL of the QA deployment
    interfaces: [notes_http]
```

The full format is the JSON Schema at <http://localhost:8000/schemas/bundle.v1.json> (also `schemas/bundle.v1.json` in this repository).

## Step 3: Upload and validate

Target, Bundles, Upload. Tessa checks the zip against the schema, scores how complete it is and shows any problems with their line numbers. If the bundle has problems, the **Fix-up prompt** gives Claude Code exactly what to correct.

## Step 4: Fill in the environment

Target, Environment. Enter a value for every variable the bundle names: base URLs, test user passwords, database connection strings for the oracles and seeds. Secret values are encrypted and never shown again. Then run the **health checks**: Tessa calls the health endpoint of every interface and tells you what it can reach.

## Step 5: Pick what to test

Open the **Catalog**. Tick features, roles and depth. Tessa shows an estimate of the cost before you save the plan. Scenarios that Claude Code authored wait in **Scenarios, Review** until a person accepts them. Tessa never accepts its own scenarios.

## Step 6: Run and watch

Start a run from the plan. On the run page you see:

- every scenario and step as it happens,
- live browser tiles (click one to follow it at a higher frame rate),
- each verdict with its tier and confidence,
- the cost and the time so far, against the budget. Over budget, the run stops. It never quietly degrades.

The Temporal UI (<http://localhost:8233>) shows the same run as workflows, which helps when something is stuck.

## Step 7: Work through the findings

Failures become **findings**, grouped so one bug is one finding. Each has its steps, the request and response, a transcript, screenshots and a repro. From a finding you can:

- copy the **Explain prompt** for Claude Code, which finds the cause in your code and posts a structured explanation,
- with the plugin, run `/tessa:fix <finding id>`: Claude Code fixes the bug on a branch, adds a test and re-runs only that scenario,
- move the finding through its states: new, triaged, in fix, verifying and resolved, or known gap and dismissed. Tessa sets it to resolved itself after a later full run passes.

## And then

| Feature | Where |
|---|---|
| Runs on a schedule, or on every commit with a CI gate | Settings, Schedules |
| Comparing two runs | Runs, Diff |
| Trends of pass rate, flakiness and cost | Runs, Trends |
| Mutation testing: does the suite catch planted bugs? | Mutation |
| Labelling steps by hand to calibrate the judge | Labels |
| HTML and JSON reports, Slack notifications | the run page, Settings, Notifications |
| Users, retention, audit log | Settings |

Next: [Using Tessa with Claude Code](07-claude-code.md)
