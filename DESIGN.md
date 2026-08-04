# policy-engine — ABC-layered, pluggable policy executors

## Goal

A CLAUDE.md-aligned (common → abc → impl → hono-factory → CLI) implementation
of the policy engine that:

1. Provides **pluggable executors as classes** behind one ABC —
   `PolicyEngineExecutor` — so an engine kind is chosen by the referenced
   record's `$type`, never by an if-branch inside an existing implementation.
   **Right now we implement exactly two:**
   - **In-process GHALite** — executes a `computer.socialweb.temp.policy.gha-lite`
     record (GitHub Actions workflow YAML as admission gates).
   - **In-process Typescript via `deno-worker-sandbox`** — executes a
     `computer.socialweb.temp.policy.typescript` record, loading its
     workerManifest bundle into a `deno-worker-sandbox` worker.
2. Adds **record lexicons** `computer.socialweb.temp.policy.gha-lite` and
   `computer.socialweb.temp.policy.typescript` usable as the **referenced
   records inside the RFP record's `policy` field** — alongside the existing
   `com.publicdomainrelay.temp.market.policies.*` records.
3. **Pre-creates records for known pre-defined policy workflows**, mirroring how
   the bidder seeds `market.offering` records on start
   (`ensureOffering` + `startOfferingRefresh`).

## Current state

Already in `policy-engine/`:

- `lib/policies/deno-typescript/` — the market policies, perspective-split
  (`bidder-only-me`, `requester-only-me`, …) plus `open`, `under-4-cpus`,
  `bid-payload`; `registry.ts` (createPolicyRegistry / policyNames).
- `lib/policies/deno-typescript-shared/` — record-centric `createPolicyCtx`
  (Agent/HTTP-backed resolve/resolveOperatorDid/getVouchedDids), cached
  `runPolicy`, inline structural types.
- `lib/policies/gha-lite/` — bundled GitHub Actions workflow actions
  (`action-common.ts`) evaluated by the engine.
- `lib/policy-engine-server-gha-lite/` — GitHub Actions workflow evaluation
  server (`main.ts api|run`, src/ workflow/action_worker/fs_api/eval).
- `lib/policy-engine-client/` — stub client (superseded by the executor ABC).

Gaps this design closes: no `PolicyEngineExecutor` ABC, no executor dispatch,
no seeder, no `computer.socialweb.temp.policy.*` record lexicons, no
hono-factory/CLI composition.

## Package layout (ABC layers)

```
policy-engine/
  lib/common/policy-common/                     @computer.socialweb.policy-common
    constants.ts      NSIDs (computer.socialweb.temp.policy.*, market NSIDs)
    types.ts          wire types: PolicySpec, PolicyArgs, PolicyResult,
                      PolicyRecord {uri,cid,value?,payload?}
    lexicons.ts       generated lexicon defs (gha-lite, typescript)
  lib/abc/policy-engine/                        @computer.socialweb.policy-engine-abc
    PolicyEngineExecutor   interface — execute(policyRecord, ctx) → PolicyResult
    PolicyEngineServer     interface — evaluate/describe/checkScope
    PolicySeeder           interface — ensure() → RecordRef[]; startRefresh(ms)
    PolicyEvalCtx          interface — resolve/resolveOperatorDid/getVouchedDids/log
    EngineRegistry         interface — get($type) → PolicyEngineExecutor
  lib/policy-engine-executor-gha-lite/          @computer.socialweb.policy-engine-executor-gha-lite
    class GhaLiteExecutor implements PolicyEngineExecutor    (in-process)
  lib/policy-engine-executor-typescript/        @computer.socialweb.policy-engine-executor-typescript
    class TypescriptExecutor implements PolicyEngineExecutor (in-process via deno-worker-sandbox)
  lib/policy-engine-server-gha-lite/            @computer.socialweb.policy-engine-server-gha-lite
    class GhaLiteServer implements PolicyEngineServer         (wraps GhaLiteExecutor)
  lib/policy-seeder-atproto/                    @computer.socialweb.policy-seeder-atproto
    class AtprotoPolicySeeder implements PolicySeeder
  lib/hono-factory-policy-engine/               @computer.socialweb.hono-factory-policy-engine
    createPolicyEngineFactory(opts)             compose server + seeder, not subclass
  hono-policy-engine/                            CLI — read config, build registry,
                                                 seed records, serve
```

Dep arrow one-way, no cycles: `common <- abc <- impl <- factory <- CLI`. A new
executor kind = a new sibling impl package + one `EngineRegistry` entry. Never a
flag/branch inside an existing impl. One `mod.ts` export per package, no
sub-module exports.

## The ABC — `PolicyEngineExecutor`

The single pluggability point. An executor is bound to a record `$type`; the
`EngineRegistry` maps record `$type` → executor.

```ts
// lib/abc/policy-engine/mod.ts
export interface PolicyEngineExecutor {
  /** Record $type this executor handles (dispatch key). */
  readonly kind: "gha-lite" | "typescript";
  /** Execute one already-resolved policy record against a ctx. */
  execute(input: {
    policyRecord: PolicyRecord;      // {uri, cid, value}; value.$type === kind
    ctx: PolicyEvalCtx;
    permissions?: Record<string, unknown>;
  }): Promise<PolicyResult>;
}

export interface EngineRegistry {
  /** Resolve a policy record's $type to an executor. */
  get($type: string): PolicyEngineExecutor | undefined;
}

export interface PolicyEngineServer {
  evaluate(input: PolicyEvalRequest): Promise<PolicyResult>;
  describe(): Promise<DescribedPolicy[]>;
  checkScope(input: ScopeRequest): Promise<PolicyResult>;
}

export interface PolicySeeder {
  /** Idempotent upsert of every known pre-defined policy record. */
  ensure(): Promise<RecordRef[]>;
  startRefresh(intervalMs: number): Deno.UnrefTimer;
}
```

## The two executor implementations

```ts
// lib/policy-engine-executor-gha-lite/mod.ts
export class GhaLiteExecutor implements PolicyEngineExecutor {
  readonly kind = "gha-lite" as const;
  async execute({ policyRecord, ctx, permissions }) {
    // value.workflow (Actions YAML) → parse jobs/steps → run sandboxed actions
    // (reuse src/workflow.ts / action_worker.ts) → PolicyResult
  }
}

// lib/policy-engine-executor-typescript/mod.ts
export class TypescriptExecutor implements PolicyEngineExecutor {
  readonly kind = "typescript" as const;
  async execute({ policyRecord, ctx, permissions }) {
    // value.manifest strongRef → com.publicdomainrelay.temp.compute.deno.workerManifest
    // → load bundle into a deno-worker-sandbox worker → run (value.manifest)
  }
}

// lib/policy-engine-server-gha-lite/mod.ts (server surface dispatches via registry)
const registry: EngineRegistry = {
  get: ($type) =>
    $type === "computer.socialweb.temp.policy.gha-lite" ? ghaLiteExecutor
    : $type === "computer.socialweb.temp.policy.typescript" ? typescriptExecutor
    : undefined,
};
```

Same ABC, two transports — the CLAUDE.md rule "two impls of same ABC = normal
way to offer alternatives".

## Record lexicons

New namespace `computer.socialweb.temp.policy` (authored, see
`lexicons/computer/socialweb/temp/policy/`):

- **`computer.socialweb.temp.policy.gha-lite`** — a GitHub Actions workflow
  used as an admission gate. `name` + inline `workflow` YAML (+ optional
  `permissions`). Evaluated by `GhaLiteExecutor`.
- **`computer.socialweb.temp.policy.typescript`** — a pre-defined TypeScript
  policy. `manifest` = **strongRef to a
  `com.publicdomainrelay.temp.compute.deno.workerManifest`** holding the bundled
  policy code (same field + resolution as the existing
  `com.publicdomainrelay.temp.market.policies.denoWorker` record; this is the
  first-party/trusted variant of that shape). Evaluated by `TypescriptExecutor`
  in a `deno-worker-sandbox` worker.

Both are `type: record`, `key: tid`, carry `name` + `createdAt` +
`signatures` (badge.blue attestations). The RFP's `policy` field is a
`com.atproto.repo.strongRef` and may point at either of these — or at any
`com.publicdomainrelay.temp.market.policies.*` record.

## Pre-create records — mirror the offering seeder

`AtprotoPolicySeeder` mirrors market-bidder's `ensureOffering` (list → match →
correct-in-place via `updateRecord` → else `createRecord`, one canonical rkey
per record, collection never grows):

```ts
// lib/policy-seeder-atproto/mod.ts
export class AtprotoPolicySeeder implements PolicySeeder {
  constructor(private atproto, private did: string, private log) {}

  async ensure(): Promise<RecordRef[]> {
    const refs = [];
    for (const def of this.definitions()) {          // known pre-defined workflows
      const existing = await this.atproto.listRecords(this.did, def.nsid, { limit: 50 });
      const rec = existing?.records?.find((r) => (r.value as any).name === def.name);
      if (rec) {
        if (this.matches(rec.value, def)) { this.log("policy exists (matched)", { uri: rec.uri }); }
        else {
          await this.atproto.updateRecord(def.nsid, rkey(rec.uri), def.build());
          this.log("policy corrected", { uri: rec.uri });
        }
        refs.push({ uri: rec.uri, cid: rec.cid });
      } else {
        const ref = await this.atproto.createRecord(def.nsid, def.build());
        refs.push(ref); this.log("policy created", { uri: ref.uri });
      }
    }
    return refs;
  }

  startRefresh(intervalMs: number): Deno.UnrefTimer {
    return setInterval(
      () => this.ensure().catch((err) => this.log("policy refresh failed", { error: String(err) })),
      intervalMs,
    );
  }
}
```

- `definitions()` = the known pre-defined workflows: the builtin policies →
  `typescript` records (bundle → `deno-worker-sandbox` workerManifest strongRef),
  plus any hand-authored `gha-lite` workflow records.
- Seeder runs on bidder/requester start after OAuth is ready, same lifecycle as
  `bidder offering created` / `startOfferingRefresh`. RFPs then reference a
  stable, pre-minted strongRef instead of minting a fresh record per RFP.

## RFP wiring

- `rfp.policy` strongRef → a pre-created `computer.socialweb.temp.policy.*`
  record (or a `com.publicdomainrelay.temp.market.policies.*` record).
- Evaluator resolves the ref, reads `$type`, `EngineRegistry.get($type)` →
  executor class → `execute`.
- Server side: `GhaLiteServer` exposes the evaluatePolicy surface, dispatching
  through the registry; composed (not subclassed) into
  `hono-factory-policy-engine`.

## Open questions

- Where does the seeder's repo live: the operator DID (like offerings) — and
  do requesters read pre-created records from a well-known DID, or does each
  side seed its own?
  - Answer: Each operator (of requester or bidder) seeds to it's own ATProto
    repo in it's PDS.
- `computer.socialweb.temp.policy.typescript.manifest` naming vs `bundle`:
  mirrors `denoWorker.manifest`; rename if the seeder/evaluator prefers `bundle`.
  - Answer: `manifest` is correct.
- Does the RFP reference a single policy record or may the policy set be an
  array of strongRefs (subcontracting chains)? Current RFP carries one ref.
  - Answer: Modify RFP so policy becomes `policies` array of strongRefs.
