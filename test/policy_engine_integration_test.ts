/**
 * policy-engine integration test — end-to-end through the ABC layers:
 *
 *   registry dispatch → GhaLiteExecutor / TypescriptExecutor execute real
 *   policy records → verdicts → AtprotoPolicySeeder upserts records →
 *   hono-factory server serves evaluatePolicy over HTTP.
 *
 * Run: deno task test   (deno test --allow-all --unstable-worker-options test/)
 */

import { assertEquals, assert } from "@std/assert";
import { GhaLiteExecutor } from "../lib/policy-engine-executor-gha-lite/mod.ts";
import { TypescriptExecutor } from "../lib/policy-engine-executor-typescript/mod.ts";
import {
  AtprotoPolicySeeder,
  ghaLitePolicyDefinition,
  typescriptPolicyDefinition,
  type AtprotoRepo,
} from "../lib/policy-seeder-atproto/mod.ts";
import {
  createPolicyEngineServer,
  createPolicyEngineFactory,
} from "../lib/hono-factory-policy-engine/mod.ts";
import type {
  PolicyEvalCtx,
  PolicyRecord,
  PolicyResult,
  StrongRef,
} from "@publicdomainrelay/policy-common";
import {
  POLICY_GHA_LITE_NSID,
  POLICY_TYPESCRIPT_NSID,
} from "@publicdomainrelay/policy-common";
import type { EngineRegistry } from "@publicdomainrelay/policy-engine-abc";
import { createScopeCache } from "@publicdomainrelay/policy-engine-scope-cache";
import { createPolicyRegistry } from "@publicdomainrelay/policy-deno-typescript";

const GHA_LITE = POLICY_GHA_LITE_NSID;
const TYPESCRIPT = POLICY_TYPESCRIPT_NSID;

// ── fixtures ─────────────────────────────────────────────────────────────────

const ALLOW_WORKFLOW = [
  "name: t",
  "on: push",
  "jobs:",
  "  j:",
  "    runs-on: self-hosted",
  "    steps:",
  "      - run: echo ok",
].join("\n");

const DENY_WORKFLOW = [
  "name: t",
  "on: push",
  "jobs:",
  "  j:",
  "    runs-on: self-hosted",
  "    steps:",
  "      - run: exit 1",
].join("\n");

const MANIFEST_URI = "at://did:plc:op/com.publicdomainrelay.temp.compute.deno.workerManifest/fixture";
const MANIFEST_CID = "bafyfixturemanifest";

function typescriptBundle(evalBody: string): string {
  // The bundle contract: assign globalThis.__evaluatePolicy (async) → PolicyResult.
  return `globalThis.__evaluatePolicy = async (input) => (${evalBody});`;
}

const ALLOW_BUNDLE = typescriptBundle(`({ allow: true, violations: [] })`);
const DENY_BUNDLE = typescriptBundle(`({ allow: false, violations: [{ msg: "denied by fixture", policyId: "typescript" }] })`);
const RPC_BUNDLE = typescriptBundle(`(async () => {
  const rec = await input.resolve({ uri: "at://did:plc:op/com.example.r/rec", cid: "cid" });
  const op = await input.resolveOperatorDid("did:plc:subject");
  const vouched = await input.getVouchedDids("did:plc:req");
  input.log("info", "rpc-probe", { rec, op, vouched });
  return { allow: rec.ok === true && op === "did:plc:op" && vouched.includes("did:plc:vouched"), violations: [] };
})()`);

function manifestRecord(bundle: string): Record<string, unknown> {
  return {
    $type: "com.publicdomainrelay.temp.compute.deno.workerManifest",
    bundle,
    lock: "{}",
    json: "{}",
    permissions: {},
    signatures: [],
  };
}

const SELF = "did:plc:op";
const SUBJECT = "did:plc:subject";
const REQ = "did:plc:req";

function baseCtx(over: Partial<PolicyEvalCtx> = {}): PolicyEvalCtx {
  return {
    policyName: "test",
    args: {},
    perspective: "requester",
    selfDid: SELF,
    subjectDid: SUBJECT,
    rootRequesterDid: REQ,
    counterpartyDid: SUBJECT,
    resolve: async () => ({}),
    resolveOperatorDid: async () => null,
    getVouchedDids: async () => new Set<string>(),
    log: () => {},
    ...over,
  };
}

function ghaLiteRecord(workflow: string): PolicyRecord {
  return {
    uri: `at://did:plc:op/${GHA_LITE}/rec`,
    cid: "cid-gha",
    value: { $type: GHA_LITE, name: "t", workflow, createdAt: new Date().toISOString() },
  };
}

function typescriptRecord(bundle: string): { record: PolicyRecord; manifest: Record<string, unknown> } {
  const manifest = manifestRecord(bundle);
  const record: PolicyRecord = {
    uri: `at://did:plc:op/${TYPESCRIPT}/rec`,
    cid: "cid-ts",
    value: {
      $type: TYPESCRIPT,
      name: "t",
      policies: [{ name: "fixture" }],
      manifest: { $type: "com.atproto.repo.strongRef", uri: MANIFEST_URI, cid: MANIFEST_CID },
      createdAt: new Date().toISOString(),
    },
  };
  return { record, manifest };
}

function registry(): EngineRegistry {
  const gha = new GhaLiteExecutor({ sandbox: { netOnly: false } });
  const ts = new TypescriptExecutor();
  return {
    get: ($type) => ($type === GHA_LITE ? gha : $type === TYPESCRIPT ? ts : undefined),
    kinds: () => [GHA_LITE, TYPESCRIPT],
  };
}

// ── 1. registry dispatch ─────────────────────────────────────────────────────

Deno.test("registry dispatches gha-lite and typescript by $type", () => {
  const reg = registry();
  assertEquals(reg.get(GHA_LITE) instanceof GhaLiteExecutor, true);
  assertEquals(reg.get(TYPESCRIPT) instanceof TypescriptExecutor, true);
  assertEquals(reg.get("computer.socialweb.temp.policy.unknown"), undefined);
  assertEquals(reg.kinds().sort(), [GHA_LITE, TYPESCRIPT].sort());
});

// ── 2. GhaLiteExecutor ───────────────────────────────────────────────────────

Deno.test("gha-lite executor allows a passing workflow", async () => {
  const executor = new GhaLiteExecutor({ sandbox: { netOnly: false } });
  const result = await executor.execute({ policyRecord: ghaLiteRecord(ALLOW_WORKFLOW), ctx: baseCtx() });
  assertEquals(result.allow, true, JSON.stringify(result));
});

Deno.test("gha-lite executor denies a failing workflow", async () => {
  const executor = new GhaLiteExecutor({ sandbox: { netOnly: false } });
  const result = await executor.execute({ policyRecord: ghaLiteRecord(DENY_WORKFLOW), ctx: baseCtx() });
  assertEquals(result.allow, false);
  assert(result.violations.length > 0);
});

Deno.test("gha-lite executor denies a record without a workflow", async () => {
  const executor = new GhaLiteExecutor({ sandbox: { netOnly: false } });
  const rec = ghaLiteRecord(ALLOW_WORKFLOW);
  delete (rec.value as Record<string, unknown>).workflow;
  const result = await executor.execute({ policyRecord: rec, ctx: baseCtx() });
  assertEquals(result.allow, false);
  assertStringIncludes(result.violations[0].msg, "no workflow");
});

// ── 2b. gate step: allow output → workflow failure ───────────────────────────

// A policy action writes allow=false to GITHUB_OUTPUT but exits 0. The gate
// step (`test "${{ steps.policy.outputs.allow }}" = "true"`) turns that into a
// failing step, so the workflow's terminal status reflects the deny. Without
// the gate the executor would map the successful workflow to allow:true —
// every policy would be a no-op. Regression for the tangled-vouch / only-me
// "always allows" bug.
Deno.test("gha-lite executor: gate step denies when the policy action writes allow=false", async () => {
  const executor = new GhaLiteExecutor({ sandbox: { netOnly: false } });
  const workflow = [
    "name: gate-deny",
    "on: push",
    "jobs:",
    "  j:",
    "    runs-on: self-hosted",
    "    steps:",
    "      - run: echo \"allow=false\" >> $GITHUB_OUTPUT",
    "        id: policy",
    "      - run: test \"${{ steps.policy.outputs.allow }}\" = \"true\"",
  ].join("\n");
  const result = await executor.execute({ policyRecord: ghaLiteRecord(workflow), ctx: baseCtx() });
  assertEquals(result.allow, false, JSON.stringify(result));
});

Deno.test("gha-lite executor: gate step allows when the policy action writes allow=true", async () => {
  const executor = new GhaLiteExecutor({ sandbox: { netOnly: false } });
  const workflow = [
    "name: gate-allow",
    "on: push",
    "jobs:",
    "  j:",
    "    runs-on: self-hosted",
    "    steps:",
    "      - run: echo \"allow=true\" >> $GITHUB_OUTPUT",
    "        id: policy",
    "      - run: test \"${{ steps.policy.outputs.allow }}\" = \"true\"",
  ].join("\n");
  const result = await executor.execute({ policyRecord: ghaLiteRecord(workflow), ctx: baseCtx() });
  assertEquals(result.allow, true, JSON.stringify(result));
});

// Real WORKFLOWS map: the gate step must be present on every bundled workflow
// so a deny from any policy (tangled-vouch, only-me, mutuals, ...) fails the
// workflow instead of being discarded.
Deno.test("gha-lite WORKFLOWS: every workflow has the allow-gate step", async () => {
  const { WORKFLOWS } = await import("../lib/policies/gha-lite/workflows.ts");
  const names = Object.keys(WORKFLOWS);
  assert(names.length >= 8, `expected the bundled workflows, got: ${names.join(", ")}`);
  for (const [name, yaml] of Object.entries(WORKFLOWS)) {
    const hasEcho = yaml.includes("steps.policy.outputs.allow");
    const hasGate = yaml.includes('test "${{ steps.policy.outputs.allow }}" = "true"');
    assert(hasEcho, `workflow ${name}: missing the policy-action step referencing steps.policy.outputs`);
    assert(hasGate, `workflow ${name}: missing the gate step test allow = "true"`);
  }
});

// ── 3. TypescriptExecutor ────────────────────────────────────────────────────

function tsCtx(manifest: Record<string, unknown>): PolicyEvalCtx {
  return baseCtx({
    resolve: async (ref: StrongRef) =>
      ref.uri === MANIFEST_URI ? manifest : { $type: "com.example.r", ok: true },
    resolveOperatorDid: async (did: string) => (did === SUBJECT ? "did:plc:op" : null),
    getVouchedDids: async () => new Set(["did:plc:vouched"]),
  });
}

Deno.test("typescript executor allows an allow bundle", async () => {
  const executor = new TypescriptExecutor();
  const { record, manifest } = typescriptRecord(ALLOW_BUNDLE);
  const result = await executor.execute({ policyRecord: record, ctx: tsCtx(manifest) });
  assertEquals(result.allow, true, JSON.stringify(result));
});

Deno.test("typescript executor denies a deny bundle", async () => {
  const executor = new TypescriptExecutor();
  const { record, manifest } = typescriptRecord(DENY_BUNDLE);
  const result = await executor.execute({ policyRecord: record, ctx: tsCtx(manifest) });
  assertEquals(result.allow, false);
  assertEquals(result.violations[0].msg, "denied by fixture");
});

Deno.test("typescript executor serves host-RPC callouts to the bundle", async () => {
  const executor = new TypescriptExecutor();
  const { record, manifest } = typescriptRecord(RPC_BUNDLE);
  const result = await executor.execute({ policyRecord: record, ctx: tsCtx(manifest) });
  assertEquals(result.allow, true, JSON.stringify(result));
});

Deno.test("typescript executor denies a record without a manifest ref", async () => {
  const executor = new TypescriptExecutor();
  const { record } = typescriptRecord(ALLOW_BUNDLE);
  delete (record.value as Record<string, unknown>).manifest;
  const result = await executor.execute({ policyRecord: record, ctx: tsCtx(manifestRecord(ALLOW_BUNDLE)) });
  assertEquals(result.allow, false);
});

// ── 4. AtprotoPolicySeeder ───────────────────────────────────────────────────

function fakeAtproto() {
  const store = new Map<string, Array<{ uri: string; cid: string; value: Record<string, unknown> }>>();
  let n = 0;
  const api: AtprotoRepo = {
    async listRecords(_did, collection) {
      return { records: store.get(collection) ?? [] };
    },
    async createRecord(collection, record) {
      n++;
      const rec = { uri: `at://did:plc:op/${collection}/rec${n}`, cid: `cid${n}`, value: record };
      store.set(collection, [...(store.get(collection) ?? []), rec]);
      return rec;
    },
    async updateRecord(collection, rkey, record) {
      const list = store.get(collection) ?? [];
      const i = list.findIndex((r) => r.uri.endsWith(`/${rkey}`));
      if (i < 0) throw new Error(`no record ${rkey}`);
      list[i] = { uri: list[i].uri, cid: list[i].cid, value: record };
      return { uri: list[i].uri, cid: list[i].cid };
    },
  };
  return { store, api };
}

function seederDefs(workflow = ALLOW_WORKFLOW) {
  return [
    typescriptPolicyDefinition({
      name: "market-builtins",
      manifestUri: MANIFEST_URI,
      manifestCid: MANIFEST_CID,
      policies: [{ name: "only-me" }],
    }),
    ghaLitePolicyDefinition({ name: "open", workflow }),
  ];
}

function makeSeeder(api: AtprotoRepo) {
  return new AtprotoPolicySeeder({ atproto: api, did: SELF, definitions: seederDefs() });
}

Deno.test("seeder creates records on first ensure()", async () => {
  const { store, api } = fakeAtproto();
  const refs = await makeSeeder(api).ensure();
  assertEquals(refs.length, 2);
  assertEquals(store.get(TYPESCRIPT)?.length, 1);
  assertEquals(store.get(GHA_LITE)?.length, 1);
  assertEquals(store.get(TYPESCRIPT)![0].value.name, "market-builtins");
  assertEquals((store.get(TYPESCRIPT)![0].value.manifest as { uri: string }).uri, MANIFEST_URI);
});

Deno.test("seeder is idempotent — second ensure() does not grow the collection", async () => {
  const { store, api } = fakeAtproto();
  const seeder = makeSeeder(api);
  await seeder.ensure();
  await seeder.ensure();
  assertEquals(store.get(TYPESCRIPT)?.length, 1);
  assertEquals(store.get(GHA_LITE)?.length, 1);
});

Deno.test("seeder corrects a changed definition in place (rkey preserved)", async () => {
  const { store, api } = fakeAtproto();
  const seeder = makeSeeder(api);
  await seeder.ensure();
  const uriBefore = store.get(GHA_LITE)![0].uri;

  // Workflow definition changed → same rkey, new value.
  const seeder2 = new AtprotoPolicySeeder({
    atproto: api,
    did: SELF,
    definitions: seederDefs("name: t\non: push\njobs:\n  j:\n    runs-on: self-hosted\n    steps:\n      - run: echo changed\n"),
  });
  await seeder2.ensure();
  assertEquals(store.get(GHA_LITE)!.length, 1);
  assertEquals(store.get(GHA_LITE)![0].uri, uriBefore);
  assertStringIncludes(store.get(GHA_LITE)![0].value.workflow as string, "echo changed");
});

// ── 5. Factory / server over HTTP ────────────────────────────────────────────

Deno.test("factory server evaluatePolicy allows a gha-lite record over HTTP", async () => {
  const { app, server } = createPolicyEngineFactory({
    registry: registry(),
    resolve: async (ref: StrongRef) => {
      if (ref.uri === MANIFEST_URI) return manifestRecord(ALLOW_BUNDLE);
      throw new Error(`unexpected resolve ${ref.uri}`);
    },
    hostname: "localhost",
  });
  assert(server);

  const rec = ghaLiteRecord(ALLOW_WORKFLOW);
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.market.evaluatePolicy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policyRecord: rec, selfDid: SELF, subjectDid: SUBJECT, rootRequesterDid: REQ }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as PolicyResult;
  assertEquals(body.allow, true, JSON.stringify(body));
});

Deno.test("factory server dispatches typescript by policyRef over HTTP", async () => {
  const { app } = createPolicyEngineFactory({
    registry: registry(),
    resolve: async (ref: StrongRef) => {
      if (ref.uri === MANIFEST_URI) return manifestRecord(ALLOW_BUNDLE);
      if (ref.uri.includes(TYPESCRIPT)) {
        return typescriptRecord(ALLOW_BUNDLE).record.value as Record<string, unknown>;
      }
      throw new Error(`unexpected resolve ${ref.uri}`);
    },
    hostname: "localhost",
  });

  const policyRef: StrongRef = {
    uri: `at://did:plc:op/${TYPESCRIPT}/rec`,
    cid: "cid-ts",
  };
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.market.evaluatePolicy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policyRef, selfDid: SELF, subjectDid: SUBJECT, rootRequesterDid: REQ }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as PolicyResult;
  assertEquals(body.allow, true, JSON.stringify(body));
});

Deno.test("factory server describes the registered kinds", async () => {
  const { app } = createPolicyEngineFactory({ registry: registry(), resolve: async () => ({}), hostname: "localhost" });
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.market.policy.describe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { policies: Array<{ name: string }> };
  assertEquals(body.policies.length, 2);
});

Deno.test("factory describe lists first-party policies per-policy when a registry is supplied", async () => {
  const { app } = createPolicyEngineFactory({
    registry: registry(),
    resolve: async () => ({}),
    policies: createPolicyRegistry(),
    hostname: "localhost",
  });
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.market.policy.describe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { policies: Array<{ name: string; kind: string; perspectives?: string[] }> };
  assert(body.policies.some((p) => p.name === "bidder-only-me" && p.kind === "trust"));
  assert(body.policies.some((p) => p.name === "under-4-cpus" && p.kind === "work" && p.perspectives?.includes("bidder")));
});

// ── 6. scope lane ────────────────────────────────────────────────────────────

Deno.test("gha-lite executor scope runs the scope-mode workflow", async () => {
  const executor = new GhaLiteExecutor({ sandbox: { netOnly: false } });
  const rec = ghaLiteRecord(ALLOW_WORKFLOW);
  const result = await executor.scope({
    policyRecord: rec,
    scope: { perspective: "requester", selfDid: SELF, counterpartyDid: SUBJECT, args: {} },
  });
  assertEquals(result?.allow, true, JSON.stringify(result));
});

Deno.test("factory checkScope runs the scope lane over HTTP with a policyRef", async () => {
  const cache = createScopeCache();
  const { app } = createPolicyEngineFactory({
    registry: registry(),
    resolve: async (ref) => {
      if (ref.uri.includes(GHA_LITE)) return ghaLiteRecord(ALLOW_WORKFLOW).value!;
      throw new Error(`unexpected resolve ${ref.uri}`);
    },
    scopeCache: cache,
    hostname: "localhost",
  });
  const policyRef: StrongRef = { uri: `at://did:plc:op/${GHA_LITE}/rec`, cid: "cid-gha" };
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.market.policy.checkScope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "t", policyRef, subjectDid: SUBJECT, rootRequesterDid: REQ }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as PolicyResult;
  assertEquals(body.allow, true, JSON.stringify(body));
});

Deno.test("factory checkScope denies without a policyRef", async () => {
  const { app } = createPolicyEngineFactory({ registry: registry(), resolve: async () => ({}), hostname: "localhost" });
  const res = await app.request("/xrpc/com.publicdomainrelay.temp.market.policy.checkScope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "t", subjectDid: SUBJECT, rootRequesterDid: REQ }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as PolicyResult;
  assertEquals(body.allow, false);
});

function assertStringIncludes(hay: string, needle: string): void {
  assert(hay.includes(needle), `expected "${hay}" to include "${needle}"`);
}
