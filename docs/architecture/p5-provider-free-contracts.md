# P5 zero-Provider contracts (DSH 0.2.1-rc.5)

Status: implemented in the current development line unless explicitly marked otherwise. This page records the rc.5 Host contracts the zero-Provider build relies on, the target call chain, the route-lease ownership rules, and the hot-install/upgrade support matrix with its recovery boundaries. It replaces the wrapper-era architecture notes for these seams.

## rc.5 Host contracts actually used

All facts below were verified against the `dsh-v0.2.1-rc.5` source tree (tag `b830ec95`):

- **Commands** support image attachments, cancellation, command events and `agent.steer()`; a registered command is discoverable by name, and a duplicate registration fails through the host `NamedEntries` error instead of overwriting.
- **Settings** register as an independent namespace (`vision-router`) — no LLM Provider is involved. The read-only settings contract revision is 7.
- **Attachment admission** stays Host-owned: the bundle patch declares `attachment-local` limits; the plugin only requests admission, never widens it silently.
- **`agent/pre-step`** receives the request's messages and a next-mutation seam; the request and its header are read-only for us except for the explicit lease markers.
- **Model directory** writes (`llm.registerAdapter`, `llm.registerConfigurableProviders`) exist as Host APIs; the zero-Provider build calls none of them. Model catalog reads (`llm.registration`, `resolveModelInfo`, `llm.models`) remain the only model-directory touchpoints.

## Target call chain (zero registration)

```text
user paste/upload ──▶ DSH composer (stock, no plugin button)
        │
        ├─ /vision on|off|status ──▶ VisionSessionService (UI-less; also ACP/headless/SDK)
        │                               └─ durable session policy (revision, 4-state persistence)
        ├─ /vision <question> + image ──▶ service submit → agent.steer()
        │
agent turn ──▶ agent/pre-step (plugin)
        ├─ image projection (text-only attested adapters get handles + notice, zero image bytes;
        │   native image models keep pixels; user-visible durable images untouched)
        └─ route lease → select a REAL Host vision model (hostVisionRoute + adapter + modality
            triple-check) → execute image tasks via Host adapter / private transport
            (free chain, custom HTTP, Ollama, LM Studio) → restore the chat model
```

There is **no** `deepseek-vision` wrapper, `vision-chain`, `<provider>-vision` twin or `vision-http` provider anywhere in the chain. Vision backend rows in settings are direct-backend entries served by the plugin's private transport.

## Route lease ownership rules

- The lease is persisted **before** the model selection is issued (crash-safe ordering); origin records the full selection including effort, target, session policy revision, plugin generation and `dvr-auto` source.
- Internal selection events are correlated by exact match; external (user) selections are never swallowed, and a real external switch cancels the lease. Effort-only edits never cancel.
- A lease is marked executed in the request header before dispatch; text-only turns restore only selections the plugin owns.
- `/vision off` revokes pending and persisted leases that have not executed.
- Crash / hot-reset recovery re-hydrates the lease from durable state (`rememberAgent`), never from `globalThis`.

## Hot install / upgrade support matrix (plan §6.2 summary)

| Operation | Support | Completion evidence |
|---|---|---|
| Web in-app first install | `pluginManager.installBundle()` + HMR | Host `application=applied`, `/vision` discoverable, health check green |
| External CLI first install | Host manifest watcher + bounded readiness check | **Not the CLI exit code** — `/vision status` plus an image smoke |
| Web/Desktop in-app upgrade | Dedicated upgrade coordinator | commands, settings, session, tasks all verified; first-install logic is not reused |
| External CLI overwrite upgrade | Not a hot-upgrade entry by default | Honestly reported as not hot-effective; no silent restart |
| Hosts without HMR (some headless/ACP) | Plain plugin capability | Honestly reported as not hot-installable |

## Recovery boundaries (plan §6.4 summary)

- rc.5 Host/Client replacement is **not** an atomic two-generation transaction: a failed candidate generation does not guarantee the old generation keeps serving. Recovery therefore follows a snapshot path: record the old exact version/artifacts, manifest and lockfile; verify the candidate in an isolated profile first; on failure reinstall the old exact version and hot-recompose, and verify old functionality returns.
- In-flight model requests use explicit drain/cancel boundaries; they are never silently replayed (no duplicate billing), and pending inboxes/tool history stay interpretable in the new generation.
- The new generation restores state from durable Settings / session policy / route lease — never from a previous generation's mutable Maps.
- A failed recovery is reported as an explicit outage with repair commands; it is never described as "the old version never stopped".
- Strict zero-interruption guarantees (old generation survives candidate failure) would require an upstream two-phase Host/Client rollback that rc.5 does not provide, and are deliberately not promised.

## Implemented vs pending

Implemented in this line: the `/vision` command and session service (durable revision, concurrency, cold resume, child-agent inheritance), provider-free routing with persistent route leases, image projection with the text-only zero-byte guarantee, zero model-directory writes, wrapper-era settings read-only migration, retired-field unset on first load, and the retired-history source reader.

Pending (documented, not shipped here): real-DSH hot-install/hot-upgrade E2E against a running Web and Desktop profile; the zero-Provider upgrade preflight UI (blocking on unmigratable data); per-OS native ABI precheck automation in the upgrade coordinator; and telemetry-free readiness UI beyond `/vision status`.
