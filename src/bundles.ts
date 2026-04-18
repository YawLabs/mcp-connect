// Curated multi-server bundles — static client-side data, not fetched from
// mcp.hosting. Each bundle is a "stack" of namespaces that commonly ship
// together for a known workflow (on-call triage, PR review, etc.). The
// `mcp_connect_bundles` meta-tool surfaces these so the model can activate
// a coherent preset in one step instead of juggling discover + load.
//
// Namespaces here are the CANONICAL short names users conventionally pick
// when installing a given server (e.g. `github`, `linear`, `slack`). If a
// user picked a different namespace locally, partial-match will still be
// useful ("you have github + linear, pr-review is ready") even if their
// slack install is called "myslack" — the bundle just won't fire on that
// account until they align the names.

export type BundleCategory = "dev" | "ops" | "growth" | "data";

export interface CuratedBundle {
  id: string;
  name: string;
  description: string;
  namespaces: string[];
  category: BundleCategory;
}

export const CURATED_BUNDLES: readonly CuratedBundle[] = [
  {
    id: "devops-incident",
    name: "DevOps Incident Triage",
    description: "GitHub + PagerDuty + Slack for on-call triage",
    namespaces: ["github", "pagerduty", "slack"],
    category: "ops",
  },
  {
    id: "pr-review",
    name: "PR Review",
    description: "GitHub + Linear for issue-to-PR traceability",
    namespaces: ["github", "linear"],
    category: "dev",
  },
  {
    id: "growth-stack",
    name: "Growth Stack",
    description: "HubSpot + Slack + GA for lifecycle + funnel signals",
    namespaces: ["hubspot", "slack", "ga"],
    category: "growth",
  },
  {
    id: "data-ops",
    name: "Data Ops",
    description: "Postgres + S3 + Snowflake for pipeline debugging",
    namespaces: ["postgres", "s3", "snowflake"],
    category: "data",
  },
  {
    id: "product-release",
    name: "Product Release",
    description: "GitHub + Linear + Slack for ship-day coordination",
    namespaces: ["github", "linear", "slack"],
    category: "dev",
  },
  {
    id: "support-ops",
    name: "Support Ops",
    description: "Zendesk + Slack + HubSpot for escalation handoffs",
    namespaces: ["zendesk", "slack", "hubspot"],
    category: "ops",
  },
];

export interface BundleMatchResult {
  ready: CuratedBundle[];
  partial: Array<{ bundle: CuratedBundle; have: string[]; missing: string[] }>;
}

/**
 * Partition the curated bundles against a set of installed namespaces.
 *
 * - `ready`: every namespace in the bundle is installed — the caller can
 *   run `mcp_connect_activate namespaces=[...]` verbatim.
 * - `partial`: at least one namespace is installed AND at least one is
 *   missing — surface the missing list so the user knows what to install.
 *
 * Bundles with zero matching namespaces are omitted entirely (noise). Pure
 * function — does not mutate `installedNamespaces` or the bundles array.
 */
export function matchBundles(installedNamespaces: Iterable<string>): BundleMatchResult {
  const installed = new Set(installedNamespaces);
  const ready: CuratedBundle[] = [];
  const partial: BundleMatchResult["partial"] = [];

  for (const bundle of CURATED_BUNDLES) {
    const have = bundle.namespaces.filter((ns) => installed.has(ns));
    const missing = bundle.namespaces.filter((ns) => !installed.has(ns));
    if (missing.length === 0) {
      ready.push(bundle);
    } else if (have.length > 0) {
      partial.push({ bundle, have, missing });
    }
  }

  return { ready, partial };
}

/**
 * One-line "how to activate" snippet per bundle. Used by the `list` action
 * so the model has a ready-to-run call site without a second round-trip.
 */
export function bundleActivateHint(bundle: CuratedBundle): string {
  return `mcp_connect_activate({ namespaces: ${JSON.stringify(bundle.namespaces)} })`;
}
