# MabiCommerceCommunity

Local-first Cloudflare Workers / TypeScript backend for optional MabiCommerce
NewLife community scan sharing. Separate from the desktop app.

## Status and boundaries

- Implemented: D1 migrations, consent-based installation registration, hashed
  private credentials, short-lived scan tickets, validated/deduplicated scan
  ingestion and bounded ticket-free outpost batches, latest data, incremental sync, paginated individual history,
  contribution totals, revocation, rate limits, and private-IP cleanup.
- A production pilot was deployed on 2026-11-09 at
  `https://mabicommerce-community.mabi-projects.workers.dev`.
  The sibling desktop's Release/user and Debug/dev builds use this same HTTPS
  endpoint. Switching backends/sharing policy or upgrading legacy unscoped consent
  turns sharing OFF until the owner explicitly accepts the current service. It has an
  initially-off Settings toggle authorizing uploads and planner downloads,
  remembering the consented ON/OFF preference across launches.
  Its paper-corner refresh icon receives/applies incremental updates at most
  once per minute, using recipient-specific purchase discounts. The former
  diagnostic viewer is removed. Local Worker testing remains separate.
- Reviewed-scan rollout (2026-11-09): all five migrations applied locally and
  remotely. Normalized-v2 readers receive reviewed-scan provenance; older public
  readers retain automatic-only compatibility. The owner confirmed real
  production scan upload and second-instance sync.
- Batch rollout (2026-11-10): backward-compatible `/v1/scan-batches` deployed;
  no schema migration or quota increase. Legacy desktop releases still work.
  Desktop batching targets v0.2.3-beta.
- `DEPLOYMENT_MODE=local` rejects non-loopback request hosts. The all-zero D1 ID
  is a local placeholder, not a production binding.
- No accounts, character names, hardware fingerprints, screenshots, raw OCR
  text, personal weekly allowance, or game-process access.
- Client arithmetic agreement is not evidence that an observation is truthful.
  Fabricated but internally consistent observations remain possible. Revocation,
  quotas, and validation are pilot safeguards, not Sybil resistance or consensus.

## Local development

Node 24 is supported by the installed Wrangler version.

```powershell
npm ci
npm run db:migrate
npm run dev
```

In another terminal:

```powershell
Invoke-RestMethod http://localhost:8787/health
Invoke-RestMethod http://localhost:8787/v1/privacy
```

Validation:

```powershell
npm run typecheck
npm test
npm run build
```

Tests execute in the local Workers runtime against D1 using the same migrations.
They do not require a Cloudflare account. `build` is a deployment dry run;
`deploy` is not. Do not deploy this local configuration.

## Production pilot

The explicit `production` environment binds the owner-supplied D1 database
`mabicommercecommunity` (`3c0cf509-84ec-42f9-8d9d-1325c7145471`), uses
`DEPLOYMENT_MODE=production`, enables workers.dev and schedules cleanup every
15 minutes with Worker observability disabled. The default local binding and
local data remain separate and unchanged.

```powershell
npx wrangler d1 migrations apply DB --env production --remote
npx wrangler deploy --env production --dry-run
npx wrangler deploy --env production
```

All five migrations have been applied to the production database;
foreign-key checks pass. No local test data was imported. Public HTTPS health,
privacy, catalog, latest and database-backed stats were verified from an external
fetch. Initial TLS handshake failures cleared without configuration changes;
Windows curl/PowerShell, Node and the actual .NET/WPF production client now connect
successfully. A desktop proof performed one consented registration, one short-lived
scan ticket and an empty normalized sync; no price observations were uploaded.

`ADMIN_TOKEN` is not configured; operator revocation fails closed until an owner
stores a random 64-character lowercase hex credential using
`npx wrangler secret put ADMIN_TOKEN --env production`. Do not put credentials in
source, documentation or chat. Platform retention/backups, billing alerts and
ongoing abuse/capacity review remain pilot follow-ups.

For rollout, apply schema before deploying readers. Keep the expanded schema on
Worker rollback; never restore old readers after anonymization begins. The local
development environment can continue independently. Do not delete or reset the
remote database to roll back an application deployment.

### Installation-link expiry migration

`0004_association_expiry.sql` preserves existing rows, quote foreign keys and scan
sequence watermarks, making installation links nullable and marking revoked
history hidden. Existing associations receive no expiry (owner-selected exemption).
Insert triggers assign 30-day deadlines only to new registrations/observations,
including inserts by an older writer during rollout. Updated readers retain
anonymous public history; expiry never deletes price/stock observations.

Apply migrations before starting the updated Worker. The current schema works
with previous writers; old readers omit anonymized rows, so do not roll readers
back after cleanup has begun. Before any new association expires, the previous
Worker can be restored while leaving the expanded schema in place. After expiry,
unlinking is intentionally irreversible: do not reconstruct erased identifiers.
Scheduled/API cleanup is transactional and retry-safe. Database backups/platform
retention are separate production concerns, not part of this local purge guarantee.

### Reviewed-scan migration and wire compatibility

Apply additive `0005_reviewed_scans.sql` before the new Worker. It adds nullable
`scans.review_json` without rewriting observations or changing expiry. Existing
writers need no change. A reviewed normalized upload optionally adds:

```json
{
  "review": { "sourceManual": false, "stockManual": true, "manualPostIds": [2, 3] }
}
```

The object marks explicit review; IDs identify only destination prices changed
in review. Source and stock have independent edit flags. Unchanged readings are
reviewed OCR, not manual. Every eligible destination and confirmed stock/source
(except source-less Barter) remain required. Reviewed Trade/Group profits may
be null when the independently read profit is missing or disagrees; no observed
profit is fabricated from edits. Supplied non-null profits still require exact
source/sale agreement. All integer limits, normalization and expiry checks remain.

Readers request `X-Community-Format: normalized-v2` to receive reviewed data and
its provenance. Old/no-header and normalized-v1 latest/sync/history readers exclude
reviewed scans, selecting the newest compatible automatic observation instead;
their cursor can still advance over hidden/incompatible sequences. This prevents
older clients treating edited data as auto-checked. Stats count all accepted scans.
Downgrading desktop readers can omit reviewed observations. After reviewed data
exists, retain the review-aware reader/filter on any Worker rollback: the old
Worker would expose nullable profits without provenance. Keep the additive
schema; no destructive rollback or history deletion is needed.

After binding/configuration changes, run `npm run cf-typegen`. The checked-in
catalog contains identifiers/names only, including rotating Barter alternatives.
Regenerate it from a local desktop checkout when that catalog changes:

```powershell
npm run catalog:import
# Or provide the source catalog path:
npm run catalog:import -- '..\MabiCommerceNewLife\Data\commerce-catalog.json'
```

## Privacy and retention

Consent version: `2026-11-09`. Registration must explicitly accept the policy
returned by `GET /v1/privacy` before any registration/scan IP log is written.

- Random installation IDs and SHA-256 hashes of independently random, 256-bit
  bearer credentials are stored. The credential is returned once and never
  appears in public responses or application logs.
- Registration and newly accepted scans store the connection IP privately.
  No IP-reading HTTP endpoint exists; authorized database operators can inspect
  those records. Public observations omit installation IDs, credentials, and IPs.
- Private IP records expire after **30 days**. Cleanup runs every 15 minutes
  through the scheduled handler and before database-backed API requests.
  Physical deletion occurs at the next successful cleanup; scheduled outages
  can delay deletion. Local `wrangler dev` does not run cron automatically.
- Rate counters use SHA-256 IP-derived bucket keys, not raw IPs, and expire
  within one hour. They are also removed by cleanup.
- **Every accepted individual price/stock observation is retained indefinitely**
  for historical charts, including its server receipt time. New observations
  lose their private installation link **30 days after receipt**, in the same
  cleanup batch as private IP expiry. Per owner choice, pre-migration observations'
  links and their legacy installations remain unchanged. Unused expired new
  installations (including hashed credentials) are deleted once no scan links,
  private logs or live tickets refer to them. New scans extend a new installation's
  expiry; each observation's own deadline stays fixed. There is no automatic
  price-history purge or daily-only aggregation.
- Revocation invalidates credentials and excludes still-linked contributions
  from public latest, sync, history, and totals. Already-anonymized observations
  cannot be traced back for installation-wide revocation. A stored per-observation
  hidden flag prevents previously revoked observations resurfacing after unlinking.
  Contributor counts cover distinct retained links only, not anonymous history.
  Historical
  records remain stored privately. Revocation is not data erasure.
- Worker observability is disabled. Unexpected failures log only a generated
  request ID and error class, never request bodies, tokens, IPs, or database
  error messages. Cloudflare platform-level retention/backups require separate
  review before production; these settings do not promise control of them.

## API v1

JSON bodies must use `Content-Type: application/json`, be at most **16,384 actual
bytes** (**65,536** for scan batches), and have exactly the documented fields. Encoded bodies are rejected.
Responses use `Cache-Control: no-store`; errors have `{ "error": "code" }`.
Unexpected server errors also include an opaque `requestId` and return 500.
No browser CORS access is enabled.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Worker liveness; not a database-readiness check |
| GET | `/v1/privacy` | Consent and retention policy |
| GET | `/v1/catalog` | Mode/product/source/destination identifiers |
| POST | `/v1/installations` | Explicit consent; returns installation ID and credential |
| POST | `/v1/scan-tickets` | Authenticated 60-second upload ticket |
| POST | `/v1/scans` | Authenticated, complete observation upload |
| POST | `/v1/scan-batches` | Authenticated, 1–16 complete observations from one outpost/mode |
| DELETE | `/v1/installation` | Authenticated self-withdrawal/revocation |
| GET | `/v1/latest` | Most recently received non-revoked scan per mode/product |
| GET | `/v1/sync` | Incremental non-revoked observations in server order |
| GET | `/v1/history` | Paginated individual observations for one mode/product |
| GET | `/v1/stats` | Non-revoked accepted-scan and contributor counts |
| POST | `/v1/admin/revoke` | Separate operator credential; revoke an installation |

### Register and upload

Current desktop clients queue accepted structured scans in memory, replacing
earlier scans of the same good. They submit `{ "scans": [<scan>, ...] }` to
`POST /v1/scan-batches` with bearer authentication: after 60s idle, at four
minutes, or when the active outpost roster is complete. Each scan uses a fresh
client-generated UUID; no per-good tickets are needed. All normal catalog,
source/profit, normalization, stock and review checks still apply. The complete
batch is validated before its scans/quotes/logs commit in one transaction.
Duplicate scan or product IDs and mixed modes/outposts are rejected.

The response is `{ "receipts": [{ "scanId", "sequence", "receivedAt", "duplicate" }] }`,
in submission order: 201 if any scan is new, otherwise 200. Exact same-ID/payload
retries are idempotent; mismatches return 409. Clients retain failed batches in
memory for manual retry only; OFF discards them and close/update asks first.
Server receipt times are approximate observation times after batching, not
capture timestamps. There is no queue persistence, image or raw OCR upload.
The existing 60/minute installation write allowance is charged **per good** in
a batch, preserving abuse limits while reducing Worker requests. Storage uses
at most 35 statements for 16 goods, plus authentication/rate-limit/cleanup work,
within the free-tier 50-query invocation limit. Roll out the
backend before a batch-capable desktop; legacy endpoints below remain supported.

1. Read/display privacy policy and obtain explicit opt-in.
2. `POST /v1/installations`:

   ```json
   { "consentVersion": "2026-11-09", "acceptPrivacy": true }
   ```

   Store the returned `installationId` and `token` privately on the client.
   Authenticated requests use `Authorization: Bearer <token>`.
3. Immediately before a user-initiated scan, `POST /v1/scan-tickets` with `{}`.
   The server returns `scanId` and `expiresAt` (Unix milliseconds).
4. Submit within 60 seconds using `POST /v1/scans`:

   ```json
   {
     "scanId": "<server-issued UUID>",
     "mode": "trade",
     "productId": 101,
     "sourcePostId": 1,
     "sourcePrice": 100,
     "priceBasis": "normalized-v1",
     "observedSourcePrice": 93,
     "purchaseDiscountPercent": 7,
     "stock": 123,
     "prices": [
       { "postId": 2, "salePrice": 120, "profit": 27 }
     ]
   }
   ```

   The example price array is abbreviated: **all eligible destinations** are
   required. Use `/v1/catalog`: sellable posts except the source, further limited
   to posts offering Group goods for Group mode. Optional `postId: 0` denotes
   Smuggler for Trade/Barter only. `stock` is observed Inventory supply, never
   personal weekly allowance or a planner-decremented quantity.

   Trade/Group: each distinct destination must satisfy
   `salePrice - profit === observedSourcePrice`, using independently read values.
   `sourcePrice` is the nearest-whole base price:
   `round(observedSourcePrice / (1 - purchaseDiscountPercent / 100))`.
   Discounts include uploader equipment and the source-post merchant level,
   range from 0 through 99 percent, and have at most two decimal places.
   Normalization is lossy; it estimates the undiscounted integer price.
   Metadata occurs once per scan, never on every destination row. Recipients
   round the base price after applying their own gear/merchant discount; the
   saved observed profit is audit data, not the recipient's profit.
   IDs must match the imported catalog and mode; source price is a positive
   integer, stock/sale price non-negative integers, all at most 1 billion.
   Signed integer profit is limited to +/-1 billion. These are storage/abuse
   bounds, not asserted game-wide price ranges.

   Barter has no source-price/profit columns. Send `sourcePrice: null` and
   `profit: null` on every quote, `observedSourcePrice: null` and
   `purchaseDiscountPercent: 0`, keeping the complete
   destination set. Never invent them from recipe costs or arithmetic. The
   desktop requires its existing Barter OCR agreement/reference-model checks;
   the server validates structure/catalog/numeric bounds/completeness but cannot
   independently verify the pixels or the live Barter reference model.
   Migration `0002_barter_sale_only.sql` preserves old scan/quote/IP records and
   converts old Barter source/profit fields to null.
   Additive migration `0003_purchase_discount.sql` preserves existing data and
   marks pre-normalization scans `legacy`, with null discount audit metadata.
   Legacy seven-field uploads remain accepted and retain their original
   canonical retry identity. Explicit `priceBasis: "legacy"` with both optional
   metadata fields null is equivalent. Never interpret a legacy buy as a base
   price, because its uploader's discount is unknown.

   Success: `{ sequence, receivedAt, duplicate }`, status 201. Server receipt time
   and sequence, never a supplied client timestamp, determine ordering.
   An identical retry (destination order ignored) returns the original receipt
   with status 200 even after ticket expiry. Different content reusing a scan ID
   returns 409. Writes are transactional, including quotes and private IP log.

Tickets bound the permitted submission window, not the age/truth of the pixels.
The desktop client must not queue offline scans, upload downloaded or
simulated values, or claim that a server ticket proves a live capture. Sharing
failures must never prevent local planning.

### Read and synchronize

Public observations have:

```text
sequence, receivedAt, mode, productId, sourcePostId, sourcePrice, stock,
priceBasis, observedSourcePrice, purchaseDiscountPercent,
prices: [{ postId, salePrice, profit }]
```

- Send `X-Community-Format: normalized-v1` to request normalized observations.
  Without it, public reads preserve the old response shape: discount metadata
  is omitted and `sourcePrice` is the observed discounted value, including for
  new normalized scans. This keeps older local test clients usable.
- `/v1/latest` returns `{ observations, revision, nextCursor }` for normalized
  clients (`nextCursor` omitted for legacy readers). The cursor watermark and
  latest rows share one D1 transaction. Bootstrap with this snapshot, then
  request `/v1/sync?cursor=<nextCursor>&revision=<revision>&limit=200`.
  Latest means last **server
  receipt**, not highest price or claimed client capture time. Quote rows remain
  tied to their scan, not mixed across observations.
- Start `/v1/sync?cursor=0&limit=100`. Save returned `nextCursor` and `revision`;
  subsequent requests send both. `limit` is 1-200. Response:
  `{ observations, nextCursor, revision, hasMore }`. Pages contain accepted scans
  in increasing server sequence, including older observations; apply only newer
  sequences per key. A watermark advances over excluded contributions so an
  empty page cannot trap the cursor.
- Moderation changes `revision`. A stale sync revision returns 409
  `{ error: "sync_reset_required", revision }`. Replace the old shared overlay
  with a fresh latest snapshot/watermark (or replay from cursor 0), and invalidate
  cached history/stats. Stage all pages and commit overlay/cursor together;
  failures leave the previous state intact.
  Latest/history/stats include revision so readers can invalidate consistently.
  Reads are transactionally paired with their revision.
- `/v1/history?mode=trade&productId=101&limit=100` returns
  `{ observations, nextBefore, revision }`, newest first. Continue with
  `before=<nextBefore>` until null. Limits are 1-200. Individual quotes remain
  available for charting; no chart UI is included.
- `/v1/stats` returns `{ acceptedScans, contributors, revision }`, excluding
  revoked installations. No public per-person tracking/leaderboard is exposed.

Clients that apply downloads must retain per-observation consumption bookkeeping:
redownloading the same stock observation must **not refill locally consumed
supply**. Group/Barter personal weekly allowance stays independent. Revocation
resync must not reset that allowance or invent refunded stock.

### Limits and moderation

- Registration: 5 per IP/hour.
- Database-backed requests: 240 per IP/minute.
- Ticket + scan writes: combined 60 per installation/minute.
- Exceeded quotas return 429 with `Retry-After`; unknown/revoked credentials 401;
  invalid data 400; expired/unknown tickets or conflicting retries 409.
- Rate buckets are atomic and use server time. Local mode uses loopback as its
  test address and ignores IP headers. Production mode accepts only
  `CF-Connecting-IP`, never caller-supplied forwarding chains. Public deployment
  and abuse policy still need review.

The operator endpoint is disabled (503) unless `ADMIN_TOKEN` is configured as a
separate random 64-character lowercase hex secret. For local moderation,
generate it into the ignored `.dev.vars` file without putting it in chat/source:

```powershell
node -e "require('fs').writeFileSync('.dev.vars', 'ADMIN_TOKEN=' + require('crypto').randomBytes(32).toString('hex') + '\n', {flag:'wx'})"
```

Restart Wrangler after setting the secret. Use that operator token, not an
installation credential, to `POST /v1/admin/revoke` with
`{ "installationId": "<UUID>" }`. Revocation is idempotent and removes pending
tickets. Private IP inspection uses authorized local D1 tooling, not public API.
There is deliberately no restore endpoint or public moderation dashboard yet.

## Production pilot rollout checklist

Infrastructure login, separate remote binding, migrations and workers.dev
deployment are complete; the desktop production HTTPS path is verified.
The following checklist also retains the outstanding operator/privacy/capacity
review and real-scan pilot steps.

1. Review client opt-in text, server trust/abuse safeguards, IP privacy notice,
   platform retention/backups, and expected database growth.
2. Authenticate locally with `npx wrangler login`; never paste credentials.
3. Create a real D1 database and bind its ID in a separate reviewed configuration.
   Apply the versioned schema remotely only after confirming the target.
4. Configure the operator secret through Cloudflare secret storage, replace the
   local-only deployment gate deliberately, and exercise production-mode tests.
5. Budget indefinite history growth and free-plan storage/read/write limits.
   A free plan does not mean unlimited history. Plan monitored capacity/backups
   before opening submissions.
6. Deploy a tested pilot on `workers.dev`. Add `commerce.inabi.co.in` later without
   disrupting existing DNS/email. No domain changes are required for local work.
7. The desktop uses **Settings > Calculator Behavior > Scanned price sharing**
   (under Screen reader mode) for both uploads and
   downloads, with initial explicit consent and memory-only credentials; the
   saved ON choice reconnects on later launches without downloading prices.
   Turning scanner mode off also saves sharing OFF. Automatic SCAN results and
   complete review-confirmed scans upload; edits carry manual provenance.
   The **refresh icon in the paper's upper-left corner** receives/applies newest shared data
   at most once per minute, including failures, without automatic polling.
   Turning sharing or scanner mode off cancels transfers and saves newest applied
   values locally, preserving consumption and weekly allowance. Release uses the
   fixed production HTTPS origin in both Release and Debug. Consent is scoped to
   backend and sharing policy, so legacy/local/automatic-only consent never
   silently enables reviewed online sharing.
   The owner confirmed an actual production scan upload and second-instance
   refresh on 2026-11-09. Repeat this check after changes to scan/wire handling.

## Repository privacy checks

Source control must not contain `.wrangler/` local D1 state, `.dev.vars`/`.env`
credentials, database exports, request logs, captured images or private keys.
Local state and dependencies stay on disk but are excluded from Git. The D1
binding UUID and public Worker address are deployment identifiers, not credentials.
Keep Cloudflare API tokens and `ADMIN_TOKEN` in secret storage only.

CI runs tests, type checking and a deployment dry run; pushing source does not
deploy the Worker or migrate any production database. Review staged paths and
secret-like values before each push. This source repository is public with owner
approval; production data, local databases and credentials are not published.

## License

Original backend source and documentation are available under the
[MIT License](LICENSE), copyright 2026 Root50199. Dependencies and generated
Cloudflare runtime declarations retain their respective licenses and notices.
Mabinogi and its game names/catalog identifiers belong to their respective
owners; this license does not grant rights to third-party game content.

`private: true` in package.json prevents accidental npm publication; it does not
restrict GitHub source visibility or the MIT license.
