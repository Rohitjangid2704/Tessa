# 7. Using Tessa with Claude Code

Claude Code is the engineer in the Tessa loop. Tessa never reads your repo. Claude Code does, on your machine, and talks to Tessa through its API.

There are two ways to work:

| | Copy and paste | The `tessa` plugin |
|---|---|---|
| Setup | none | install the plugin once |
| How | copy a prompt from the web app, paste it into Claude Code, upload what it writes | run a skill such as `/tessa:discover` and Claude Code calls Tessa itself |
| Good for | trying Tessa, or when you cannot install plugins | everyday work |

The direction is always the same: Claude Code calls Tessa, and Tessa never calls Claude Code. Your code, your `.env` and your dev database stay on your laptop. Only the `tessa/` folder and the environment values you confirm leave it.

## Option 1: copy and paste

Every prompt surface in the web app (Discovery, Fix-up, Explain, Author, Mutants, Hooks) has a **Copy** button:

1. Copy the prompt.
2. Open your app's repository in VS Code with the Claude Code extension, or run `claude` in a terminal in that folder.
3. Paste the prompt and let Claude Code work.
4. Upload the `tessa/` zip, or paste the explanation back, as the prompt says.

## Option 2: the `tessa` plugin

### Install

You need Claude Code 2.1 or newer and Node 24 on your PATH (on Windows, 24.20.0 or newer).

1. **Create a personal token.** In the Tessa web app: Settings, Tokens, Create token. Copy it: it starts with `ipt_` and is shown only once.
2. **Add the marketplace.** Point Claude Code at this repository, or at your local clone:

   ```bash
   claude plugin marketplace add https://github.com/Rohitjangid2704/Tessa
   # or
   claude plugin marketplace add /path/to/Tessa
   ```

3. **Install the plugin:**

   ```bash
   claude plugin install tessa@tessa
   ```

4. **Enter the settings** Claude Code asks for:

   | Setting | What to enter |
   |---|---|
   | Tessa API URL | `http://localhost:8000` (the origin only, without `/api/v1`) |
   | Tessa personal token | the `ipt_` token from step 1. Claude Code keeps it in the OS credential store, never in a file |
   | Targets to watch | optional: target ids whose new findings and failed runs should reach your session |
   | Push channel | leave it off (a research preview, see Channel below) |

5. **Start Claude Code in your app's repository** (the folder that holds, or will hold, `tessa/`) and run:

   ```
   /tessa:connect
   ```

   It checks the token, lists your targets and shows the state of one.

### The skills

| Skill | What it does |
|---|---|
| `/tessa:connect [target]` | checks the connection and shows a target |
| `/tessa:discover [target]` | asks Tessa for the Discovery prompt, writes `tessa/`, validates it (up to three passes), uploads it, fills the environment from your `.env` after you confirm the names, and runs the health checks |
| `/tessa:run [target] [plan or scenario ids]` | starts a run, waits for it, reads the verdicts and the failing steps (it asks first, because a run spends budget) |
| `/tessa:explain <finding id>` | investigates a finding in your code and posts a structured explanation |
| `/tessa:fix <finding id>` | fixes the cause on a local `fix/<id>` branch with a test, asks how to deploy to QA, re-runs only that scenario and moves the finding to verifying. It never pushes |
| `/tessa:propose [target] [areas]` | reads routes, pages, migrations, git history and tests and writes `tessa/proposal.yaml`: what to test next, ranked by risk |
| `/tessa:author [target] [items]` | writes scenarios, oracle SQL, seeds and flows for the ticked proposal items, tests them against a dev or QA database you confirm and uploads them for review |
| `/tessa:mutants [target]` | plants single, deliberate bugs on local branches to measure whether the suite catches them |
| `/tessa:hooks [target]` | adds the QA-only test hooks Tessa needs (behind a flag that is off by default) on a `tessa/hooks` branch |

A typical first session:

```
/tessa:connect
/tessa:discover
/tessa:run
/tessa:explain <finding id>
/tessa:fix <finding id>
```

### What the plugin will and will not do

- Every write tool asks for your permission each time. Only read tools are pre-approved.
- It never writes to a production target and never reports a verdict the API did not return.
- It never self-approves a scenario. Authored scenarios wait in the review queue for a person.
- Your `.env` is never uploaded as a file. Claude Code shows you the variable names, and only the pairs you confirm are sent.
- Tool results are redacted: tokens, bearer values and anything that looks like a password, secret, DSN or key are masked.
- Every write made with your token is in the Tessa audit log, with the Claude Code session that made it.

### The inbox: Tessa news in your session

For the targets you watch, the plugin listens to Tessa's live feeds. New findings, failed runs and newly ticked proposal items become short lines that a hook shows to Claude Code at your next prompt, for example:

```
Tessa inbox:
kind=finding.created target=<id> id=<id> high bug 'Checkout total ignores the discount'
```

These lines are data, never instructions.

**Privacy note:** the plugin's Stop hook sends the first 500 characters of Claude's last message in a session to Tessa as the session summary, after masking tokens. Remove the `Stop` entry from `plugin/hooks/hooks.json`, or turn it off with `/hooks`, if you do not want that.

### Channel (optional, research preview)

With the "Push channel" setting on and Claude Code started as `claude --dangerously-load-development-channels plugin:tessa@tessa`, events reach a running session at once instead of at the next prompt. It is a research preview of Claude Code and is not needed.

### Unattended runs

`plugin/bin/tessa-loop` runs a skill headless (`claude -p`) in a repository and prints one JSON result, for example in a nightly job. It uses the Claude subscription of whoever owns `CLAUDE_CODE_OAUTH_TOKEN`. Tessa itself never calls Claude.

### Troubleshooting the plugin

| Symptom | Fix |
|---|---|
| "Tessa plugin needs its token" | run `/plugin`, open tessa and enter the token |
| `401` or "token revoked" | create a new token in Settings, Tokens, and update the plugin setting |
| `Connection closed` for the tessa tools on Windows | update Node to 24.20.0 or newer |
| The skills cannot find `tessa/` | start Claude Code from the root of your app's repository |

Next: [How it works](08-how-it-works.md)
