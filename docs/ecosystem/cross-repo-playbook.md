# Playbook: Running This Evaluation From Another Repo in the Stack

This is a self-contained runbook for an agent session whose GitHub access is scoped to
**SmallChat**, **Stenographer**, or **Short-Hand** (not AgentVault) to produce the equivalent
ecosystem evaluation from that repo's vantage point. It exists because each of these repos is a
single-repo-scoped session in practice — no one session can browse all four at once — so the
evaluation has to be re-run per repo and then reconciled.

The AgentVault-side version of this evaluation lives at
[`docs/ecosystem/executive-summary.md`](./executive-summary.md) and
[`docs/ecosystem/engineering-guide.md`](./engineering-guide.md) in
`github.com/johnnyclem/AgentVault`. Read those first if you can reach them (public repo, fetchable
via raw GitHub URLs even without API scope) — don't re-derive the parts of the story they already
cover; extend and correct them from what only your repo's source can tell you.

## 0. Constraints to expect

- Your session's GitHub tools (`mcp__github__*` or equivalent) will be scoped to **one repo only**
  — almost certainly the one you're sitting in. Do not assume you can call
  `search_code`/`get_file_contents`/etc. against the other three repos. If you try and it's denied,
  that's expected, not a bug.
- You still have `WebFetch`/`WebSearch`. Use them exactly the way the AgentVault-side evaluation
  did: fetch `https://raw.githubusercontent.com/johnnyclem/<repo>/<branch>/README.md` (try `main`
  then `master`) and `https://github.com/johnnyclem/<repo>` directly for repo metadata (stars,
  language mix, description) for the three repos you can't browse.
- Every claim you make about a repo you didn't directly read source in must be flagged as
  README-sourced, not verified. This is not optional — the AgentVault-side docs got this wrong
  in one respect worth avoiding: don't assert a feature exists in another repo just because its
  README claims it. (See §4 below — this is the single most likely place your evaluation adds real
  value over the AgentVault-side one.)

## 1. Orient yourself in your own repo first

Before comparing anything, answer these about the repo you're actually sitting in:

1. What does this project do, one sentence, in its own words (README, package.json
   `description`)?
2. What's its public interface — CLI commands, exported functions/classes, MCP tools, REST
   endpoints? List them concretely (file + line references), not from memory of the README.
3. What's its actual dependency graph — `package.json` `dependencies`/`peerDependencies`. Does it
   depend on, or get depended on by, any of the other three project names
   (`agentvault`, `smallchat`, `stenographer`, `short-hand`, `@smallchat/core`,
   `@stenographer/core`)? Search case-insensitively across the whole repo, not just
   `package.json` — check source, tests, docs, and examples too:

   ```bash
   grep -rli "agentvault\|smallchat\|stenograph\|short-hand\|shorthand" . \
     --exclude-dir=node_modules --exclude-dir=.git
   ```

4. What's the project's actual maturity signal — version number, test count, CI status, last
   commit date, open issues/PRs referencing integration with the other three.

Do not skip step 3. It is the single highest-leverage check: it tells you immediately whether this
repo already has a real, working bridge to a sibling project, or whether — like AgentVault's
relationship with Stenographer and Short-Hand — the "ecosystem" is currently a shared design
philosophy with no code behind it yet.

## 2. Map your repo's role against the four-layer model

The AgentVault-side docs proposed this layering:

```
 AgentVault        →  the body        (durable, on-chain execution + wallet + secrets)
 SmallChat         →  the reflexes    (deterministic tool selection, no schema bloat)
 Stenographer      →  the memory      (passive conversation observer + GraphRAG index)
 Short-Hand        →  working memory  (compacts raw history into an LLM-sized context frame)
```

Your job is not to accept this framing uncritically — it's to **test it against your repo's actual
code**. Specifically:

- Does your repo's real public API match the one-line role assigned to it above? (E.g., if you're
  in `short-hand`, does the shipped `CompactionEngine` actually take input from something shaped
  like Stenographer's `search_conversation` output and produce output shaped like something
  SmallChat or an LLM prompt would consume — or is that connection aspirational?)
- Are there code paths, adapters, or config options in your repo that *name* one of the other three
  projects, even if not as an npm dependency (e.g., a documented integration guide, an example
  config, an adapter interface with a matching shape)?
- Is there anything in your repo that overlaps with or duplicates a responsibility AgentVault
  already has (e.g., AgentVault's `MemoryRepo` for structured on-chain memory, or its vendored
  SmallChat-pattern tool dispatch in `src/orchestration/smallchat-*.ts`)? Flag duplication risk
  explicitly.

## 3. Gather what you can about the sibling repos

For the three repos you can't browse directly, use `WebFetch`/`WebSearch` the way the AgentVault
evaluation did:

```
WebFetch https://github.com/johnnyclem/<repo>
WebFetch https://raw.githubusercontent.com/johnnyclem/<repo>/main/README.md
WebFetch https://raw.githubusercontent.com/johnnyclem/<repo>/master/README.md   # if main 404s
```

If you're in `short-hand` or `stenographer`, also directly fetch the **AgentVault** repo's relevant
source files by raw URL, since AgentVault is public — you don't need API scope to `GET` a raw file:

```
https://raw.githubusercontent.com/johnnyclem/AgentVault/main/src/orchestration/smallchat-bridge.ts
https://raw.githubusercontent.com/johnnyclem/AgentVault/main/src/orchestration/polytician-enricher.ts
https://raw.githubusercontent.com/johnnyclem/AgentVault/main/docs/memory-repo.md
https://raw.githubusercontent.com/johnnyclem/AgentVault/main/docs/ecosystem/engineering-guide.md
```

This lets you directly verify or refute claims the AgentVault-side engineering guide made about
your repo, and vice versa — cross-checking both directions is the whole point of doing this from
multiple repos.

## 4. Look specifically for README-vs-reality gaps

This is the most valuable thing a same-repo agent can do that an outside evaluator cannot: **check
whether the README's claims match the shipped code.** Concretely, for whichever repo you're in:

- **If you're in `short-hand`:** its README bills it as "language middleware for Stenographer and
  SmallChat." Find the actual adapter/interface code that talks to either. If it doesn't exist yet,
  say so plainly — that's a materially different fact than "the bridge exists and works," and it
  changes the AgentVault-side recommendation (which currently treats Short-Hand as pluggable
  middleware ready to slot into `polytician-enricher.ts`).
- **If you're in `stenographer`:** check the actual adapter list (`jsonl`, `claude-code`,
  `anthropic`, `openai`, `generic`) against source — is there (or a documented path to) an
  `agentvault` or `smallchat`-aware adapter? Check whether the MCP tool schemas
  (`search_conversation`, `get_decisions`, etc.) match what the AgentVault-side guide assumed.
- **If you're in `smallchat`:** check whether `@smallchat/core`'s public dispatch API could
  realistically replace AgentVault's vendored `SmallChatBridge`/`ToolClass` implementation, or
  whether AgentVault's canister-specific constraints (Candid method binding, 64MB heap, cycle
  metering — see `smallchat-compression.ts`'s 38-byte binary record format) mean the vendored fork
  is actually the right call long-term, not just a stopgap. Your repo's source is the only place
  that question can be answered with confidence.

## 5. Write the two deliverables, same shape as AgentVault's

Match the AgentVault-side structure so all four repos end up cross-linkable:

- `docs/ecosystem/executive-summary.md` — one-line-per-project table, the four-layer thesis (revised
  if your findings contradict it), a "key finding" section stating what's actually wired vs.
  aspirational **from your repo's vantage**, and a short recommendation list.
- `docs/ecosystem/engineering-guide.md` — component reference, an updated data-flow diagram if your
  findings change it, a table of concrete file references in *your* repo relevant to
  cross-project integration, explicit confirmation/refutation of the AgentVault-side guide's claims
  about your repo, and a phased integration roadmap from your repo's side (e.g. if you're in
  `stenographer`, what would it take to ship an `agentvault`-flavored log adapter).
- Add a "Sourcing note" at the top of both files identical in spirit to the ones in AgentVault's
  version: state plainly which repos you had source access to and which you evaluated from public
  READMEs only.
- Cross-link back to AgentVault's docs (`https://github.com/johnnyclem/AgentVault/blob/main/docs/ecosystem/engineering-guide.md`) and, once they exist, to the equivalent docs in the other two
  sibling repos.
- Link the new docs from your repo's main README or docs index, the same way AgentVault's
  `docs/index.md` got an "Ecosystem" section added.

## 6. Git workflow

Same shape as this repo's process:

1. Work on a clearly-named branch (e.g. `claude/ecosystem-eval-<repo>`), not `main`/`master`
   directly.
2. Commit with a descriptive message; don't bundle unrelated changes.
3. Push with `-u origin <branch>`.
4. Check for an existing open PR on that branch before creating a new one; check for a PR template
   in the repo (`.github/PULL_REQUEST_TEMPLATE.md` etc.) and mirror its sections if present.
5. Open the PR against the repo's default branch, ready for review (not draft), with a summary that
   states plainly what's new/confirmed/refuted relative to the AgentVault-side docs.
6. If asked to babysit the PR, subscribe to its activity and handle CI/review feedback the same way
   this session did for `johnnyclem/AgentVault#61` — fix small things directly, ask before anything
   architecturally significant, and don't consider the job done until the PR is merged or closed.

## 7. Definition of done

- Both docs exist in your repo under `docs/ecosystem/`.
- Every claim about a repo you didn't have source access to is explicitly flagged as
  README-derived.
- At least one README-vs-reality check from §4 was actually performed and reported, not skipped.
- The docs are linked from your repo's docs index/README.
- A PR is open (or merged) with these changes.
