# Total Recall — a write-once/read-many archive of agent memories

Total Recall is the migration path between assistants. Someone has used
ChatGPT for three years; the data export gives them conversations but not
the memories ChatGPT quietly built about them, and nothing gives them the
memories as they change. They import the export and the memories they can
copy out, connect the assistants they use to the AgentVault MCP server, and
set a guardrail that every memory event is written to a total-recall volume.
The server runs over stdio, so any MCP client that can launch a local server
can connect. Every memory a connected assistant creates, recalls or updates
lands in the volume; the assistant they are moving to ingests the stream
through the same MCP server or a notification hook, and the person migrates
at the pace they build trust.

The volume is append-only: nothing in it is ever rewritten. It is also
stenographer-native, so the full transcript (when enabled) and the memory
ledger both get entities, decisions, supersession and GraphRAG search for
free.

## The volume

A volume is a directory, by default `.agentvault/total-recall/`:

| File | What it is | Mutability |
|---|---|---|
| `volume.json` | identity (`volumeId`, `createdAt`) and the guardrail policy | ordinary config |
| `memories.jsonl` | one line per memory event: `created`, `recalled`, `updated`, `deleted` | append-only, hash-chained |
| `transcript.jsonl` | optional: one line per conversation turn, stenographer `jsonl` shape | append-only, hash-chained |
| `anchors.jsonl` | head hashes recorded at points in time (locally or on-chain) | append-only |

Every archive line carries `seq`, `prevHash` and `hash` (SHA-256 of the
canonical JSON of the line without `hash`). A memory event looks like:

```json
{"format":"agentvault-total-recall/memory-v1","seq":12,"id":"mem_…","ts":"2026-10-21T10:00:00.000Z",
 "op":"updated","source":{"provider":"chatgpt","agent":"gpt-5","session":"conv-9"},
 "memory":{"key":"coffee","title":"Coffee","content":"Likes pour-over, no sugar","tags":["pref"]},
 "contentHash":"…","prevHash":"…","hash":"…"}
```

A changed memory is a new `updated` event; a forgotten one is a `deleted`
event; both keep every earlier version readable (`agentvault total-recall
history`). Readers fold the events into the current state of each memory
(`list`, `search`, `total_recall_list`). Writers append under a directory
lock and fsync before releasing it, so two MCP server processes (one per
connected assistant) extend one chain. The one write that isn't an append:
bytes after the last newline that don't parse as a record were an
interrupted write, never a record, and the next append truncates them after
saying so on stderr.

`agentvault total-recall verify` re-walks both chains and checks them
against the last anchor, which catches an edited, removed or reordered
line, and a truncation past the anchor. Like any hash chain in one
directory, it shows *that* the archive changed, not who changed it;
anchoring the heads elsewhere (`anchor --canister-id`, a signed MemoryRepo
commit) is what makes truncation of the newest lines detectable.

## Quick start: the guided setup

```bash
agentvault total-recall onboard
```

One conversation, about two minutes:

1. **Your archive.** Where it lives: your home folder (one archive for every
   assistant and project, the default), this project, or anywhere. If one
   already exists it is found and reused.
2. **What to keep.** Memories only, or memories plus a full transcript; and
   whether to note when an assistant *recalls* a memory.
3. **Bring your history in.** Your ChatGPT data export (the unzipped folder
   or `conversations.json`; sharded `conversations-000.json` files are read
   in order) and ChatGPT's saved memories. The export leaves the memories
   out, so the wizard hands you a prompt to paste into ChatGPT that returns
   them verbatim, and takes the answer by paste or from a file.
4. **Connect your assistants.** Claude Code (`.mcp.json` in the project) and
   Claude Desktop. The server entry uses absolute paths to `node` and the
   CLI, because GUI apps like Claude Desktop don't inherit your shell's
   `PATH`, so an `npx` or `agentvault` that works in a terminal is often not
   found there.

Then it does all of it, and **proves it works**: it starts the server the
way an assistant would, against a throwaway copy of your policy, and checks
that the guardrail is delivered, the tools are listed, a probe memory
written is read back, and the hash chain verifies. The probe never touches
your real archive. The last screen hands you the words to say to Claude
(pull everything with `total_recall_pull`, summarize it, ask about anything
outdated, and keep recording).

It is safe to run again whenever you like, for example with a newer ChatGPT
export: imports are idempotent by message id, nothing already archived is
rewritten, an assistant config that already has the entry is reported
"already connected", and a config that changes is backed up first
(`<file>.bak-<timestamp>`). A config file that isn't valid JSON is left
exactly as it was and reported. Ctrl-C at any question changes nothing.

**ChatGPT, honestly.** Your ChatGPT history and saved memories come across
through the export and the pasted list. *Live* capture from ChatGPT (every
new memory it forms while you keep using it) needs ChatGPT to reach the
server, and ChatGPT connects to remote MCP servers over HTTPS, while
AgentVault's server speaks stdio only today. The wizard says so and offers
ChatGPT greyed out. Until an HTTP transport exists, re-run the wizard with a
fresh export to top up.

### Scripted

`--yes` skips every question and uses flags; nothing is connected unless
`--connect` says so, and the result is printed as JSON (exit code 1 if any
step reported a problem):

```bash
agentvault total-recall onboard --yes \
  --transcript append --record-recalls on \
  --chatgpt-export ~/Downloads/chatgpt-export \
  --memories ./chatgpt-memories.txt \
  --connect claude-code,claude-desktop
```

| Flag | Meaning |
|---|---|
| `--volume <dir>` (on `total-recall`) | the archive; else `$AGENTVAULT_TOTAL_RECALL_DIR`, else the one found below |
| `--transcript off\|append` | what to keep; unset keeps an existing archive's setting |
| `--record-recalls on\|off` | whether `recalled` events are kept |
| `--chatgpt-export <path>` | `conversations.json`, or the unzipped export folder |
| `--memories <file>` | ChatGPT's saved memories, one per line |
| `--connect <list>` | `claude-code`, `claude-desktop`, or `none` |
| `--project <dir>` | where Claude Code's `.mcp.json` goes (default: here) |
| `--no-test` | skip the end-to-end server check |

### Which archive a command uses

Every `total-recall` command resolves the archive the same way: `--volume`,
then `$AGENTVAULT_TOTAL_RECALL_DIR`, then `./.agentvault/total-recall` if it
exists, then `~/.agentvault/total-recall` if it exists, else the project
default (where `init` creates one). A home-folder archive is therefore found
from anywhere.

## Quick start: by hand

```bash
# 1. Create the volume (transcript off by default)
agentvault total-recall init
agentvault total-recall policy --transcript append      # optional: full transcript

# 2. Serve it over stdio to every MCP client that can launch a local server
agentvault mcp serve --total-recall ./.agentvault/total-recall
```

Register that command as a local (stdio) MCP server in each client that can
launch one, such as Claude Code (`.mcp.json`) or Claude Desktop (its config
file). The server has no remote transport, so an assistant that only accepts
remote connectors cannot reach it; bring that assistant's history in with
`import` (step 3). On connect, each client receives the volume's guardrail as
the server's `instructions`:

> GUARDRAIL: whenever you create, recall, update or delete a memory about the
> user (your own memory feature included), call total_recall_record in the
> same turn with op set to one of: created, recalled, updated, deleted. …

```bash
# 3. Bring in what the export does give you
agentvault total-recall import chatgpt ~/Downloads/chatgpt-export/conversations.json
agentvault total-recall import memories ./pasted-memories.md --provider chatgpt

# 4. Watch it fill, verify it, search it
agentvault total-recall status
agentvault total-recall log --since 0
agentvault total-recall search "coffee"
agentvault total-recall verify

# 5. Index it with stenographer
agentvault total-recall stenographer --run
```

## MCP tools

Served by `agentvault mcp serve` next to the `hypervault_*` and `wiki_*` tools.

| Tool | Does | Guardrail role |
|---|---|---|
| `total_recall_record` | append a memory event (`op`, `key`, `content`, `provider`, optional `title`, `tags`, `agent`, `session`) | what every connected assistant calls on create/recall/update/delete |
| `total_recall_transcribe` | append a conversation turn (`role`, `content`, `session`, `provider`) | only when `policy.transcript` is `append` |
| `total_recall_pull` | events after `since_seq`, oldest first, with `next_seq` and `more` | the ingestion path for the assistant being migrated to |
| `total_recall_list` | current memories, folded | read |
| `total_recall_search` | lexical search over current memories | read |
| `total_recall_history` | every version and recall of one memory | read |
| `total_recall_status` | counts, chain heads, policy, last anchor | read |
| `total_recall_verify` | re-walk both chains against the last anchor | read |
| `total_recall_policy` | the guardrail text and the policy behind it | an agent re-reads its instructions |

Writes the policy refuses (a provider not on the allow-list, an op not
recorded, a transcript turn while transcript mode is off) come back as tool
errors that restate the policy, so a client cannot quietly write the wrong
thing. Readers are annotated `readOnlyHint`.

## Guardrail policy

`volume.json` holds the policy; `agentvault total-recall policy` shows and
edits it.

| Field | Default | Meaning |
|---|---|---|
| `recordMemories` | `true` | record memory events at all |
| `transcript` | `off` | `append`: every turn goes to `transcript.jsonl` |
| `providers` | `[]` (any) | providers allowed to write |
| `recordOps` | all four | which ops are kept (`--record-recalls off` drops the noisy one) |
| `webhooks` | `[]` | POST each memory event here as it lands; loopback unless `allowRemote` |
| `hookCommand` | none | argv run per event with the event JSON on stdin |

AgentVault cannot reach into another product and force a write. The
guardrail is enforced at the two points it controls: the `instructions`
every connecting client receives, and the tools' refusals. A client that
ignores its instructions can still fail to record; `total_recall_status`
and `log` show what did land.

## Ingesting on the Claude side

Three ways, by how much the ingester wants to be driven:

1. **Pull over MCP.** Claude calls `total_recall_pull` with the last
   `next_seq` it saw (start at `0`) and gets the volume's new and updated
   memories in order. This is the path that needs nothing but the server.
2. **Notification hook.** `agentvault total-recall watch --hook ./ingest.sh`
   follows `memories.jsonl` and runs the command for each new event with the
   event JSON on stdin, persisting a cursor so a restart resumes. Several
   watchers can follow one volume under different `--cursor` names. The same
   sinks can live in the policy (`policy --hook …`, `policy --webhook …`), in
   which case the MCP server fires them as it writes and `watch` replays them
   for events written elsewhere.
3. **Webhook.** `policy --webhook http://127.0.0.1:8787/total-recall` POSTs
   `{"type":"total_recall.memory","volumeId":…,"event":…}` per event. Remote
   hosts need `--allow-remote`, the same boundary stenographer draws.

## Stenographer

`transcript.jsonl` lines are stenographer `jsonl` messages (`id`, `role`,
`content`, `timestamp`, `sessionId`, `model`, `toolCalls`) with the chain
fields as extra keys stenographer ignores, so
`stenographer start <volume>/transcript.jsonl` needs no adapter.
`memories.jsonl` has stenographer's `total-recall` adapter (auto-detected
by the `format` tag), which reads each `created`/`updated` event as the
assistant stating the memory, in a session per provider. `agentvault
total-recall stenographer` prints the command and a combined `.mcp.json`
(`total-recall` + `stenographer` servers); `--run` launches it.
Stenographer never writes to a volume.

## Anchoring

`agentvault total-recall anchor` records the current heads in
`anchors.jsonl`. With `--canister-id`, it first verifies the volume, then
commits the heads as a signed MemoryRepo commit (tags `total-recall`,
`anchor`) using the same identity rules as `agentvault memory` (an identity
PEM, `AGENTVAULT_ICP_IDENTITY_PEM_FILE`, or dfx's selected identity), and
records the commit id as the anchor's `ref`. `verify` then reports a
volume whose chains no longer extend the anchored heads.

## Library

```ts
import { TotalRecallVolume, watchVolume, notifyEvent } from 'agentvault/total-recall';

const volume = TotalRecallVolume.openOrInit('.agentvault/total-recall', { policy: { transcript: 'append' } });
volume.appendMemoryEvent({ op: 'created', source: { provider: 'claude' }, memory: { key: 'coffee', content: 'Likes pour-over' } });
volume.appendTranscript({ role: 'user', content: 'hello', sessionId: 'conv-1', provider: 'claude' });
volume.foldMemories();          // current memories
volume.readMemoryEvents({ sinceSeq: 0 });
volume.verify();                // both chains + anchor
watchVolume(volume, (event) => console.log(event.seq, event.op, event.memory.key));
```

## Limits (v1)

- Reads load a whole file; a volume of hundreds of thousands of events
  wants an index (stenographer's, or a follow-up). A single
  `conversations.json` is read into memory whole, which a very large
  unsharded export can exceed; ChatGPT shards big exports, and the importer
  reads the shards one at a time.
- The server speaks stdio only, so assistants that need a remote MCP URL
  (ChatGPT today) can't write to it live.
- The lock is a directory lock file; it serializes writers on one machine,
  not across machines sharing a network filesystem.
- Search is lexical. Semantic search over the archive is stenographer's job.
