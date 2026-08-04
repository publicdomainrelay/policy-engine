/**
 * policy-seeder-atproto — pre-creates known pre-defined policy workflow records,
 * mirroring how the bidder seeds market.offering records (ensureOffering +
 * startOfferingRefresh). Each operator seeds its own ATProto repo in its PDS.
 *
 * Idempotent upsert per definition: list existing records of the nsid, match on
 * `name`, correct-in-place via updateRecord (one canonical rkey per record,
 * the collection never grows), else createRecord. ensure() returns the
 * strongRefs callers put into RFP.policies[].
 */

import type { PolicySeeder } from "@publicdomainrelay/policy-engine-abc";
import type { RecordRef, RefreshHandle } from "@publicdomainrelay/policy-common";

/** Minimal structural atproto repo client — same shape as atproto-market's. */
export interface AtprotoRepo {
  listRecords(
    did: string,
    collection: string,
    opts?: { limit?: number },
  ): Promise<{ records: Array<{ uri: string; cid: string; value: Record<string, unknown> }> }>;
  createRecord(collection: string, record: Record<string, unknown>): Promise<{ uri: string; cid: string }>;
  updateRecord(collection: string, rkey: string, record: Record<string, unknown>): Promise<{ uri: string; cid: string }>;
}

/** One known pre-defined policy workflow the seeder keeps in sync. */
export interface PolicyDefinition {
  /** Record NSID, e.g. computer.socialweb.temp.policy.typescript. */
  nsid: string;
  /** Stable record name, e.g. "market-builtins" — the dedup key. */
  name: string;
  /** Build the full record value (incl $type, name, createdAt). */
  build(now: string): Record<string, unknown>;
  /** True when an existing record value is already correct (no rewrite). */
  matches(existing: Record<string, unknown>): boolean;
}

export interface AtprotoPolicySeederOpts {
  atproto: AtprotoRepo;
  did: string;
  definitions: PolicyDefinition[];
  log?: (level: string, msg: string, meta?: Record<string, unknown>) => void;
}

const noopLog = () => {};

export class AtprotoPolicySeeder implements PolicySeeder {
  readonly #atproto: AtprotoRepo;
  readonly #did: string;
  readonly #definitions: PolicyDefinition[];
  readonly #log: (level: string, msg: string, meta?: Record<string, unknown>) => void;

  constructor(opts: AtprotoPolicySeederOpts) {
    this.#atproto = opts.atproto;
    this.#did = opts.did;
    this.#definitions = opts.definitions;
    this.#log = opts.log ?? noopLog;
  }

  async ensure(): Promise<RecordRef[]> {
    const refs: RecordRef[] = [];
    for (const def of this.#definitions) {
      const now = new Date().toISOString();
      let existing;
      try {
        existing = await this.#atproto.listRecords(this.#did, def.nsid, { limit: 50 });
      } catch (err) {
        this.#log("warn", "policy seed: list failed", { nsid: def.nsid, error: String(err) });
        continue;
      }
      const rec = existing?.records?.find((r) => (r.value as Record<string, unknown>).name === def.name);
      if (rec) {
        const rkey = rec.uri.split("/").pop() ?? "";
        if (def.matches(rec.value)) {
          this.#log("info", "policy exists (matched)", { uri: rec.uri });
        } else {
          try {
            await this.#atproto.updateRecord(def.nsid, rkey, def.build(now));
            this.#log("info", "policy corrected", { uri: rec.uri });
          } catch (err) {
            this.#log("warn", "policy seed: update failed", { uri: rec.uri, error: String(err) });
          }
        }
        refs.push({ uri: rec.uri, cid: rec.cid });
      } else {
        try {
          const ref = await this.#atproto.createRecord(def.nsid, def.build(now));
          refs.push(ref);
          this.#log("info", "policy created", { uri: ref.uri });
        } catch (err) {
          this.#log("warn", "policy seed: create failed", { nsid: def.nsid, name: def.name, error: String(err) });
        }
      }
    }
    return refs;
  }

  startRefresh(intervalMs: number): RefreshHandle {
    const timer = setInterval(
      () => this.ensure().catch((err) => this.#log("warn", "policy refresh failed", { error: String(err) })),
      intervalMs,
    );
    return {
      stop: () => clearInterval(timer),
    };
  }
}

/** Helper: build a PolicyDefinition for a typescript policy record (bundle via workerManifest strongRef). */
export function typescriptPolicyDefinition(opts: {
  name: string;
  manifestUri: string;
  manifestCid: string;
  policies: Array<{ name: string; args?: Record<string, unknown> }>;
  permissions?: Record<string, unknown>;
}): PolicyDefinition {
  const { name, manifestUri, manifestCid, policies, permissions } = opts;
  return {
    nsid: "computer.socialweb.temp.policy.typescript",
    name,
    build: (now) => ({
      $type: "computer.socialweb.temp.policy.typescript",
      name,
      policies,
      manifest: { $type: "com.atproto.repo.strongRef", uri: manifestUri, cid: manifestCid },
      ...(permissions ? { permissions } : {}),
      createdAt: now,
    }),
    matches: (existing) =>
      existing.name === name &&
      (existing.manifest as { uri?: string } | undefined)?.uri === manifestUri &&
      existing.createdAt != null,
  };
}

/** Helper: build a PolicyDefinition for a gha-lite policy record (inline workflow YAML). */
export function ghaLitePolicyDefinition(opts: {
  name: string;
  workflow: string;
  permissions?: Record<string, unknown>;
}): PolicyDefinition {
  const { name, workflow, permissions } = opts;
  return {
    nsid: "computer.socialweb.temp.policy.gha-lite",
    name,
    build: (now) => ({
      $type: "computer.socialweb.temp.policy.gha-lite",
      name,
      workflow,
      ...(permissions ? { permissions } : {}),
      createdAt: now,
    }),
    matches: (existing) => existing.name === name && existing.workflow === workflow,
  };
}
