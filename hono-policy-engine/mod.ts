/**
 * hono-policy-engine — thin CLI entrypoint. Reads config via cli-args-env,
 * builds the EngineRegistry (gha-lite + typescript executors), composes the
 * policy engine server via the hono factory, and serves via createServe.
 *
 * No hand parsing / no inline defaults: Command resolves flags -> env ->
 * config.json -> cli-args-env.json defaults. I/O lives here in the CLI layer
 * only (createServe + signal handlers).
 *
 * Seeding: the AtprotoPolicySeeder is exercised by the integration test. Wiring
 * it here requires an atproto client (OAuth/LocalPDS) + a repo DID — see
 * lib/policy-seeder-atproto for the AtprotoRepo shape to plug in.
 */

import { Command } from "@publicdomainrelay/cli-args-env";
import { createLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import { GhaLiteExecutor } from "@publicdomainrelay/policy-engine-executor-gha-lite";
import { TypescriptExecutor } from "@publicdomainrelay/policy-engine-executor-typescript";
import { createPolicyEngineFactory } from "@publicdomainrelay/hono-factory-policy-engine";
import { createScopeCache } from "@publicdomainrelay/policy-engine-scope-cache";
import { createPolicyRegistry } from "@publicdomainrelay/policy-deno-typescript";
import type { EngineRegistry } from "@publicdomainrelay/policy-engine-abc";
import {
  POLICY_GHA_LITE_NSID,
  POLICY_TYPESCRIPT_NSID,
  splitAtUri,
  type StrongRef,
} from "@publicdomainrelay/policy-common";
import { getPdsEndpoint } from "@atproto/common-web";
import { IdResolver } from "@atproto/identity";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

/** Resolve an at:// strongRef over the network via the repo's PDS. */
export function makeResolver() {
  const idr = new IdResolver();
  return async (ref: StrongRef): Promise<Record<string, unknown>> => {
    const { repo, collection, rkey } = splitAtUri(ref.uri);
    const doc = await idr.did.resolve(repo);
    if (!doc) throw new Error(`could not resolve did ${repo}`);
    const pds = getPdsEndpoint(doc);
    if (!pds) throw new Error(`no pds endpoint for ${repo}`);
    const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
    url.searchParams.set("repo", repo);
    url.searchParams.set("collection", collection);
    url.searchParams.set("rkey", rkey);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`getRecord failed: ${res.status}`);
    const data = await res.json() as { value: Record<string, unknown> };
    return data.value;
  };
}

/** Build the two-executor registry (gha-lite + typescript). */
export function buildRegistry(): EngineRegistry {
  const gha = new GhaLiteExecutor();
  const ts = new TypescriptExecutor();
  return {
    get: ($type: string) =>
      $type === POLICY_GHA_LITE_NSID ? gha
        : $type === POLICY_TYPESCRIPT_NSID ? ts
        : undefined,
    kinds: () => [POLICY_GHA_LITE_NSID, POLICY_TYPESCRIPT_NSID],
  };
}

if (import.meta.main) {
  let runtimeConfig: Record<string, unknown> | null = null;
  try {
    const mod = await import("./config.json", { with: { type: "json" } });
    runtimeConfig = mod.default as Record<string, unknown>;
  } catch {
    /* optional */
  }

  const { options } = await new Command(
    "CONFIG_PATH_HONO_POLICY_ENGINE",
    cliArgsEnv,
    runtimeConfig,
  ).resolve();

  const port = options.port as number;
  const hostname = options.hostname as string;
  const logger = createLogger({ serviceName: "hono-policy-engine" });

  const registry = buildRegistry();
  const { app } = createPolicyEngineFactory({
    registry,
    resolve: makeResolver(),
    scopeCache: createScopeCache(),
    policies: createPolicyRegistry(),
    hostname,
    log: (level, msg, meta) => {
      if (level === "error") logger.error(msg, meta);
      else if (level === "warn") logger.warn(msg, meta);
      else logger.info(msg, meta);
    },
  });

  const serve = createServe({
    logger,
    tcp: {
      port,
      certFile: options.tlsCertFile as string | undefined,
      keyFile: options.tlsKeyFile as string | undefined,
    },
    portFile: options.portFile as string | undefined,
  });
  serve.app.route("/", app as never);

  function shutdown() {
    serve.shutdown();
    Deno.exit(0);
  }
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await serve.beginServe();
}
