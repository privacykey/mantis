import { type DocOptions, splitUrl } from "./util";

/**
 * Plaintext credential and config stores — the files an intruder who already
 * has a shell goes looking for, and the ones infostealer and forensic tooling
 * greps by name.
 *
 * The fake secrets throughout are documented example values (AWS's own
 * AKIAIOSFODNN7EXAMPLE, Stripe's published test key) or generated nonsense, so
 * nothing here is a real credential anywhere. That matters: these files get
 * committed to repos by mistake, and a canary that trips a secret scanner with
 * a plausible-looking live key creates work for someone.
 *
 * How they fire differs from the document formats and the difference is worth
 * stating plainly: a .docx beacons when it is *opened*. These beacon when the
 * URL inside them is *used* — by a human who curls it, or by a tool pointed at
 * the endpoint. The dashboard says so per preset rather than implying a file
 * that fires on sight.
 *
 * Several of these put the trigger URL in a BASE-URL field (API_BASE_URL, the
 * aws profile's endpoint_url, the kubeconfig server). Tools consuming those
 * append their own path — a bucket and object, a REST operation, /api/v1/… —
 * and the trigger route records `<trigger URL>/<anything>` for exactly that
 * reason (src/app/c/[publicId]/[...rest]).
 */

export function generateEnv(opts: DocOptions): Promise<Buffer> {
  const body = [
    "# Production environment — DO NOT COMMIT",
    "# Synced from Vault at deploy time; this copy is for local debugging only.",
    "",
    "NODE_ENV=production",
    "LOG_LEVEL=info",
    "",
    "DATABASE_URL=postgres://app_admin:ze1Pho1ai5oh4uic9Aeph8eiriop1ie@prod-db-primary.internal.example.com:5432/production_main",
    "REDIS_URL=redis://:Choj9eshohs5shoo9oosh3eichi3aiCh@prod-cache.internal.example.com:6379/0",
    "",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "AWS_REGION=us-east-1",
    "S3_BUCKET=example-prod-uploads",
    "",
    "STRIPE_SECRET_KEY=sk_live_4eC39HqLyjWDarjtT1zdp7dc",
    "SENTRY_DSN=https://a1b2c3d4e5f60718@o123456.ingest.sentry.io/1234567",
    "",
    "# Internal service endpoints",
    `API_BASE_URL=${opts.url}`,
    // Under the trigger URL, not the bare origin, so calling it registers too.
    `DEPLOY_WEBHOOK_URL=${opts.url}/hooks/deploy`,
    "SESSION_SECRET=ohB7eim8aen2yaiP4thaeg6aighai7Ai",
    "",
  ].join("\n");
  return Promise.resolve(Buffer.from(body, "utf8"));
}

export function generateAwsCredentials(opts: DocOptions): Promise<Buffer> {
  const body = [
    "# ~/.aws/credentials",
    "# Rotated 2026-03-14. Prod access is break-glass only — see runbook.",
    "",
    "[default]",
    "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region = us-east-1",
    "",
    "[prod-breakglass]",
    "aws_access_key_id = AKIAI44QH8DHBEXAMPLE",
    "aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY",
    "region = us-east-1",
    // The AWS CLI and SDKs honour endpoint_url in a profile, so a tool pointed
    // at this profile resolves against the canary rather than AWS. Root-URI
    // operations (sts, iam, ec2, s3 ls) hit the URL as is; path-bearing ones
    // (a bucket or object, lambda, apigateway) append to it.
    `endpoint_url = ${opts.url}`,
    "",
    "[terraform-state]",
    "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region = eu-west-1",
    "",
  ].join("\n");
  return Promise.resolve(Buffer.from(body, "utf8"));
}

/**
 * `.netrc`. Discovery bait, like the VPN/RDP profiles: entries match on HOST
 * only, so a tool that consumes the file (git, wget, ftp, curl with --netrc)
 * sends the bait login to the canary host but never asks for this key's path —
 * that alone records nothing. The hit comes when someone requests the restore
 * URL in the header comment.
 *
 * That comment has to sit ABOVE the first `machine` line: Python's stdlib
 * netrc parser (and anything built on it) rejects a comment that follows an
 * entry, and a .netrc that does not parse is a tell.
 */
export function generateNetrc(opts: DocOptions): Promise<Buffer> {
  const { host } = splitUrl(opts.url);
  const body = [
    "# ~/.netrc — used by curl, wget, git and ftp",
    "# chmod 600. Do not sync to shared storage.",
    `# Restore endpoint: ${opts.url}`,
    "",
    "machine github.com",
    "  login svc-deploy",
    "  password ghp_R2dPk9wXyZ4mNbV7hJlA3sWeQ1tYuI",
    "",
    "machine artifacts.internal.example.com",
    "  login ci-runner",
    "  password ze1Pho1ai5oh4uic9Aeph8eiriop1ie",
    "",
    `machine ${host}`,
    "  login backup-agent",
    "  password Choj9eshohs5shoo9oosh3eichi3aiCh",
    "",
  ].join("\n");
  return Promise.resolve(Buffer.from(body, "utf8"));
}

/**
 * kubeconfig. The `server:` value is the bare trigger URL. Someone who finds
 * the file and curls the endpoint to see what cluster it is registers, and so
 * does kubectl itself: it appends its own API paths to the server URL, which
 * the trigger route records like any other request under the trigger URL
 * (kubectl then fails on the non-Kubernetes reply).
 */
export function generateKubeconfig(opts: DocOptions): Promise<Buffer> {
  const body = [
    "apiVersion: v1",
    "kind: Config",
    "current-context: prod-admin",
    "clusters:",
    "- name: prod",
    "  cluster:",
    `    server: ${opts.url}`,
    "    insecure-skip-tls-verify: true",
    "- name: staging",
    "  cluster:",
    "    server: https://k8s-staging.internal.example.com:6443",
    "    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUM5VENDQWQyZ0F3SUJBZ0lC",
    "contexts:",
    "- name: prod-admin",
    "  context:",
    "    cluster: prod",
    "    user: admin",
    "    namespace: default",
    "users:",
    "- name: admin",
    "  user:",
    "    token: eyJhbGciOiJSUzI1NiIsImtpZCI6IkY3ZG1FYVJ2S0ZnUTNqLWFsUEpn",
    "",
  ].join("\n");
  return Promise.resolve(Buffer.from(body, "utf8"));
}
