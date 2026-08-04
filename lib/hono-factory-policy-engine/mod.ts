/**
 * hono-factory-policy-engine — Hono surface for the policy engine.
 *
 * COMPOSITE factory covering both executors (gha-lite + typescript): the caller
 * composes the executors into an EngineRegistry and passes it in. Composed, not
 * subclassed, per the org ABC-layering rule — a new executor = a sibling
 * package + one registry entry, never a subclass or a branch inside this
 * factory. The executor packages are intentionally NOT imported here; dispatch
 * happens through the registry.
 *
 * createPolicyEngineServer builds a concrete PolicyEngineServer that dispatches
 * evaluate() through an EngineRegistry ($type -> executor) and runs checkScope
 * through the shared evaluator's scope lane (record ref -> scope-mode verdict,
 * scope-cache backed).
 *
 * createPolicyEngineFactory wraps that server in a Hono app exposing the
 * policy-engine XRPC endpoints plus a did:web identity document.
 *
 * Layer: hono-factory. Depends on abc (types) + common (types/NSIDs) + hono +
 * the evaluator (scope lane).
 */

import { Hono } from "hono";
import type {
  EngineRegistry,
  PolicyEngineExecutor,
  PolicyEngineServer,
} from "@publicdomainrelay/policy-engine-abc";
import {
  type DescribedPolicy,
  MARKET_EVALUATE_POLICY_NSID,
  type PolicyArgs,
  type PolicyEvalCtx,
  type PolicyEvalRequest,
  type PolicyPerspective,
  type PolicyRecord,
  type PolicyResult,
  type ScopeRequest,
  type StrongRef,
} from "@publicdomainrelay/policy-common";
import { createPolicyEvaluator } from "@publicdomainrelay/policy-engine-evaluator";
import type { ScopeCache } from "@publicdomainrelay/policy-engine-scope-cache";
import type { PolicyRegistry } from "@publicdomainrelay/policy-deno-typescript-shared";

/** Options for createPolicyEngineServer — everything the server needs to run. */
export interface PolicyEngineServerOptions {
  /** $type -> executor dispatch table. */
  registry: EngineRegistry;
  /** Resolve a strongRef to a record body (used to load policy records from a policyRef). */
  resolve: (ref: StrongRef) => Promise<Record<string, unknown>>;
  /** Resolve a did to its operator did (hosted-server guest). Optional. */
  resolveOperatorDid?: (did: string) => Promise<string | null>;
  /** Resolve the set of dids vouched for by `did`. Optional. */
  getVouchedDids?: (did: string) => Promise<Set<string>>;
  /** Host scope verdict cache — checkScope serves repeat checks from cache. */
  scopeCache?: ScopeCache;
  /** First-party policy registry — describe() lists these per-policy. */
  policies?: PolicyRegistry;
  /** Structured logger; defaults to a no-op. */
  log?: (level: string, msg: string, meta?: Record<string, unknown>) => void;
  /** Human description per $type for describe(); falls back to a generic line. */
  descriptions?: Record<string, string>;
}

/** Options for createPolicyEngineFactory — server options plus the serve hostname. */
export interface PolicyEngineFactoryOptions extends PolicyEngineServerOptions {
  /** Hostname the did:web identity doc is minted for. */
  hostname: string;
}

/** Fail-closed result used for server-level denials. */
function deny(msg: string): PolicyResult {
  return { allow: false, violations: [{ msg, policyId: "server" }] };
}

/**
 * Concrete PolicyEngineServer. Dispatches evaluate() through the registry,
 * resolves policyRefs with the caller's resolve(), runs checkScope through the
 * shared evaluator's scope lane (scope-cache backed), and describes the
 * first-party policy registry when one is supplied.
 */
export function createPolicyEngineServer(
  opts: PolicyEngineServerOptions,
): PolicyEngineServer {
  const { registry, policies } = opts;
  const resolveOperatorDid = opts.resolveOperatorDid ??
    (async (_did: string) => null);
  const getVouchedDids = opts.getVouchedDids ??
    (async (_did: string) => new Set<string>());
  const log = opts.log ??
    ((_level: string, _msg: string, _meta?: Record<string, unknown>) => {});

  const evaluator = createPolicyEvaluator({
    registry,
    resolve: opts.resolve,
    resolveOperatorDid,
    getVouchedDids,
    scopeCache: opts.scopeCache,
    policies,
    log,
  });

  /** Build the host-brokered PolicyEvalCtx handed to executors. */
  function buildCtx(
    input: PolicyEvalRequest,
    policyRecord: PolicyRecord,
    args: PolicyArgs,
  ): PolicyEvalCtx {
    return {
      policyName: input.name ??
        String(
          policyRecord.value?.name ?? policyRecord.value?.$type ?? "policy",
        ),
      args,
      perspective: input.perspective ?? "requester",
      selfDid: input.selfDid ?? input.rootRequesterDid,
      counterpartyDid: input.counterpartyDid ?? input.subjectDid,
      subjectDid: input.subjectDid,
      rootRequesterDid: input.rootRequesterDid,
      resolve: opts.resolve,
      resolveOperatorDid,
      getVouchedDids,
      log,
      policyRef: input.policyRef,
      demand: input.demand,
      offer: input.offer,
    };
  }

  async function evaluate(input: PolicyEvalRequest): Promise<PolicyResult> {
    let policyRecord = input.policyRecord;

    if (!policyRecord && input.policyRef) {
      let value: Record<string, unknown> | null = null;
      try {
        value = await opts.resolve(input.policyRef);
      } catch {
        value = null;
      }
      if (value === null) {
        return deny(`failed to resolve policy ref ${input.policyRef.uri}`);
      }
      policyRecord = {
        uri: input.policyRef.uri,
        cid: input.policyRef.cid,
        value,
      };
    }

    if (!policyRecord) {
      return deny("no policy record or ref");
    }

    const $type = String(policyRecord.value?.$type ?? "");
    const executor: PolicyEngineExecutor | undefined = registry.get($type);
    if (!executor) {
      return deny(
        `unknown policy record type: ${$type === "" ? "(empty)" : $type}`,
      );
    }

    const args: PolicyArgs = input.args ??
      ((policyRecord.value?.args ?? {}) as PolicyArgs);
    const ctx = buildCtx(input, policyRecord, args);

    return executor.execute({
      policyRecord,
      ctx,
      permissions: policyRecord.value?.permissions as
        | Record<string, unknown>
        | undefined,
    });
  }

  async function describe(): Promise<DescribedPolicy[]> {
    if (policies) {
      return policies.names().map((name) => {
        const p = policies.get(name)!;
        return {
          name,
          kind: p.kind,
          description: p.description,
          ...(p.kind === "work" ? { perspectives: p.perspectives } : {}),
        };
      });
    }
    return registry.kinds().map((k) => ({
      name: k,
      kind: "trust",
      description: opts.descriptions?.[k] ?? `Pre-defined policy of type ${k}`,
    }));
  }

  async function checkScope(input: ScopeRequest): Promise<PolicyResult> {
    if (!input.policyRef) {
      return deny("checkScope requires a policyRef (a scope check runs the record's scope-mode lane)");
    }
    return await evaluator.scope({
      ref: input.policyRef,
      perspective: (input.perspective ?? "requester") as PolicyPerspective,
      selfDid: input.selfDid ?? input.rootRequesterDid,
      counterpartyDid: input.counterpartyDid ?? input.subjectDid,
      args: input.args ?? {},
    });
  }

  return { evaluate, describe, checkScope, registry };
}

/**
 * Wrap the concrete server in a Hono app exposing the policy-engine XRPC
 * surface: evaluatePolicy, policy.describe, policy.checkScope, and the
 * did:web identity document.
 */
export function createPolicyEngineFactory(
  opts: PolicyEngineFactoryOptions,
): { app: Hono; server: PolicyEngineServer } {
  const server = createPolicyEngineServer(opts);
  const app = new Hono();

  app.get("/.well-known/did.json", (c) =>
    c.json({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: `did:web:${opts.hostname}`,
      service: [
        {
          id: "#market_policy_evaluate",
          type: "PolicyEngineService",
          serviceEndpoint: `https://${opts.hostname}`,
        },
      ],
    }));

  app.post(`/xrpc/${MARKET_EVALUATE_POLICY_NSID}`, async (c) => {
    const body = await c.req.json().catch(() => null) as
      | PolicyEvalRequest
      | null;
    if (body === null) return c.json({ error: "InvalidRequest" }, 400);
    return c.json(await server.evaluate(body));
  });

  app.post(
    "/xrpc/com.publicdomainrelay.temp.market.policy.describe",
    async (c) => {
      return c.json({ policies: await server.describe() });
    },
  );

  app.post(
    "/xrpc/com.publicdomainrelay.temp.market.policy.checkScope",
    async (c) => {
      const body = await c.req.json().catch(() => null) as ScopeRequest | null;
      if (body === null) return c.json({ error: "InvalidRequest" }, 400);
      return c.json(await server.checkScope(body));
    },
  );

  return { app, server };
}
