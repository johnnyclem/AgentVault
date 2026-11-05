# container-notes

The smallest agent that shows what the container runtime is for: it runs with no network, keeps state across restarts, and (optionally) calls a model without ever holding the API key.

See the [container guide](../../docs/guides/container.md) for the full picture.

## Try it

```bash
# 1. Package (needs Docker).
agentvault package examples/container-notes --target container

# 2. Run with no network and no credential: it just keeps notes.
agentvault run examples/container-notes -d --network none
agentvault container logs container-notes
#   notes: this is start #1; 1 line(s) in /data/notes.log
#   model: no model configured (run with --service anthropic to enable one)

# 3. State survives a stop and a fresh start.
agentvault stop container-notes
agentvault run examples/container-notes -d --network none
agentvault container logs container-notes      # ... start #2; 2 line(s)

# 4. Snapshot the data, encrypted (prompts for a passphrase, or set AGENTVAULT_SNAPSHOT_PASSPHRASE).
agentvault stop container-notes
agentvault snapshot create container-notes

# 5. Give it a model, through the credential proxy. The credential is opted into at run time;
#    to make an image *require* one instead, package it with `--secret anthropic` (it then
#    refuses to start without the proxy rather than run without its key).
export ANTHROPIC_API_KEY=sk-ant-...
agentvault rm container-notes
agentvault run examples/container-notes -d --service anthropic --secrets-from-env
agentvault container logs container-notes      # model: <a five-word greeting>
docker logs av-container-notes-proxy           # one audit line: POST /anthropic/v1/messages 200

# 6. Prove the agent never held the key (prints the placeholder, not your key):
agentvault container exec container-notes -- printenv ANTHROPIC_API_KEY

# Clean up (the last command deletes the data).
agentvault rm container-notes --volumes -y
```

If step 5 prints `model call failed: HTTP 502`, the sidecar could not reach the API: look at the `upstreamError` code in `docker logs av-container-notes-proxy` (a code such as `SELF_SIGNED_CERT_IN_CHAIN` means a TLS-inspecting proxy sits between you and the API).
