# CLAUDE.md-alignment fix plan

Fix every finding from the three read-only alignment reviews (layering /
package-structure / CLI-style). Nothing here changes behavior — it renames
packages into the org namespace, restores package boundaries, and rebuilds the
CLI on org tooling. Tests must stay 14/14 green; `deno task check` must stay
exit 0.

Rule that applies everywhere: **all packages use the `@publicdomainrelay`
namespace** (`@publicdomainrelay/<name>`). The dotted `@computer.socialweb`
scope was rejected by Deno; `@socialweb` was the temp stand-in and is being
replaced.

---

## Phase 0 — Rename `@publicdomainrelay/*` → `@publicdomainrelay/*`

| old | new |
|---|---|
| `@publicdomainrelay/policy-common` | `@publicdomainrelay/policy-common` |
| `@publicdomainrelay/policy-engine-abc` | `@publicdomainrelay/policy-engine-abc` |
| `@publicdomainrelay/policy-engine-executor-gha-lite` | `@publicdomainrelay/policy-engine-executor-gha-lite` |
| `@publicdomainrelay/policy-engine-executor-typescript` | `@publicdomainrelay/policy-engine-executor-typescript` |
| `@publicdomainrelay/policy-seeder-atproto` | `@publicdomainrelay/policy-seeder-atproto` |
| `@publicdomainrelay/hono-factory-policy-engine` | `@publicdomainrelay/hono-factory-policy-engine` |
| `@publicdomainrelay/policy-engine-server-gha-lite` | `@publicdomainrelay/policy-engine-server-gha-lite` |

Touch points (every occurrence):
- Each package `deno.json` (the `name` field + the `jsr:` URLs in its own `imports`).
- Every `from "@publicdomainrelay/..."` import in all `mod.ts` files, the integration
  test, and the CLI.
- `hono-policy-engine/deno.json` imports.
- `DESIGN.md` package table.

Existing packages already in `@publicdomainrelay` (sandbox-abc/common/deno,
deno-typescript-shared) stay as-is. Verify `lib/policies/deno-typescript` +
`lib/policies/gha-lite` package names during this pass (reviewer flagged
`gha-lite` as missing a name) — set them to `@publicdomainrelay/policies-*`
with uniform 0.0.0 + Unlicense, or drop them from the workspace if they are
not importable libraries.

## Phase 1 — CRITICAL #1: give `policy-engine-server-gha-lite` a library surface

Currently the executor imports sibling internals
`../policy-engine-server-gha-lite/src/workflow.ts` (bypasses the package
boundary; breaks on JSR publish).

- Add `lib/policy-engine-server-gha-lite/mod.ts` exporting:
  - `WorkflowExecutor` (from `src/workflow.ts`)
  - request/status types: `PolicyEngineRequest`, `PolicyEngineStatus`,
    `PolicyEngineComplete`, `StatusComplete`, `ExitStatusSuccess`,
    `ExitStatusFailure` (from `src/models.ts`)
  - `SandboxConfig`, `resolveSandboxConfig` (from `src/config.ts`)
- Change `deno.json`: `"exports": "./mod.ts"` (was `./main.ts`); `version` →
  `0.0.0` (uniform). Keep `main.ts` + tasks (they run `main.ts` directly, not
  the package export, so this is safe).
- Rewrite `lib/policy-engine-executor-gha-lite/mod.ts` imports from
  `../policy-engine-server-gha-lite/src/*` → `@publicdomainrelay/policy-engine-server-gha-lite`.

## Phase 2 — CRITICAL #2 + #3: rebuild the CLI on org tooling

- Wire org packages into `policy-engine/deno.json` `imports` via path mappings
  (cross-repo workspace members are rejected; same mechanism as the sandbox
  packages):
  - `@publicdomainrelay/cli-args-env` → `../typescript-helpers/lib/cli-args-env/mod.ts`
  - `@publicdomainrelay/logger` → `../typescript-helpers/lib/logger/mod.ts`
  - `@publicdomainrelay/serve` → `../typescript-helpers/lib/serve/mod.ts`
  - transitive: `@cliffy/command` (jsr, resolves via cli-args-env's own
    deno.json), `@hono/hono` (already mapped).
- Add `hono-policy-engine/cli-args-env.json`:
  - `port` (number, env `PORT`, default 8080)
  - `hostname` (string, env `HOSTNAME`, default `localhost`)
- Rewrite `hono-policy-engine/mod.ts`:
  - `new Command("CONFIG_PATH_HONO_POLICY_ENGINE", cliArgsEnv, runtimeConfig).resolve()`
    → `options` (no hand parsing, no inline defaults).
  - `createLogger({ serviceName: "hono-policy-engine" })` for structured logs.
  - `createServe({ logger, relays, ... })` + `beginServe()`/`shutdown()`
    instead of raw `Deno.serve`; `onConnected` mounts the factory app.
  - Import executors by bare `@publicdomainrelay/policy-engine-executor-*`.
- Keep `makeResolver()` + `buildRegistry()` as exported helpers.

## Phase 3 — WARN cleanup

- **CLI relative executor imports** → bare `@publicdomainrelay/...` (covered by
  Phase 2 rewrite).
- **Orphan packages**: delete `lib/policy-engine-client` (superseded stub per
  DESIGN.md), `lib/policy-engine-client-cache`, `lib/policy-engine-server`
  (both empty). No code references them.
- **`lib/policies/gha-lite` package identity**: give it `name`/`exports`/
  `version`/`license` (Phase 0) or drop from workspace if unused as a library.
- **Factory name lacks transport suffix**: it is a composite factory covering
  both executors. Document that explicitly in the factory header (compose
  pattern per CLAUDE.md), no rename.
- **Sandbox deps mapped to sibling paths**: keep (cannot publish sibling
  repos); document as a publish-gap in DESIGN.md, not a violation locally.

## Phase 4 — INFO cleanup

- **abc purity**: replace `startRefresh(): ReturnType<typeof setInterval>` with
  a `RefreshHandle { stop(): void }` interface defined in `policy-common`;
  `AtprotoPolicySeeder.startRefresh` returns a handle wrapping
  `clearInterval`.
- **Non-ASCII comments**: replace em-dashes `—` and box-drawing separators with
  ASCII (`--`, `-`) across all touched files.
- **Workspace ordering**: reorder `deno.json` workspace members by layer
  (common, abc, policies, impl, factory, CLI).

## Phase 5 — Verify

- `deno task check` → exit 0.
- `deno task test` → 14 passed, 0 failed.
- CLI boots on a real socket: POST
  `/xrpc/com.publicdomainrelay.temp.market.evaluatePolicy` with a gha-lite
  record → `200 {"allow":true}`.
- `grep -rn "@socialweb" .` → zero hits (namespace fully migrated).

## Phase 6 — RFP `policy` → `policies[]` array (atproto-market)

- `atproto-market/lexicons/com/publicdomainrelay/temp/market/rfp.json`:
  replace the single `policy` strongRef field with `policies` (array of
  `com.atproto.repo.strongRef`). Absent/empty array = no restriction (open).
- `atproto-market/lib/requester-xrpc/mod.ts` (rfpRecord build, ~line 1118):
  write `rfpRecord.policies = [policyRef]` (array) instead of `policy`.
- Bidder reads — `atproto-market/lib/market-bidder-compute/mod.ts` (~88) and
  `lib/market-bidder-worker/mod.ts` (~81): replace the single
  `if (rfp.policy)` branch with a loop over `rfp.policies`, evaluating each
  policyRef (first deny short-circuits); absent/empty → no policy gate.
- Grep downstream RFP minters (`social-web-computer/components/swc-request-compute.js`,
  `compute-spa`, `digitalocean-bidder`) for RFP `policy:` writes; update to
  `policies: [...]`.
- Update atproto-market tests that assert the RFP `policy` field shape.
- Verify: atproto-market tests pass (must stay green), policy-engine tests
  unaffected.

## Non-goals / documented decisions

- Seeder live wiring into the CLI needs an atproto client (OAuth/LocalPDS);
  seeder behavior is covered by the integration test.
- Sandbox + typescript-helpers path mappings are local-only; JSR publish of
  those sibling repos is a follow-up.
