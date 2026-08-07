# Fulfillment Review MCP

A Streamable HTTP MCP server for investigating partial-fulfillment holds and preparing complete human-review cases. It reads a synthetic commerce snapshot, calculates source-supported fulfillment options, presents delivery-date and shipping-cost effects together, and persists one immutable escalation in PostgreSQL for a human decision.

The server does not modify inventory, reservations, fulfillment routing, or shipments. It does not rank, recommend, select, or execute an option.

## Try the hosted workflow

The deployed MCP server can be tested without cloning this repository or running the application locally.

- MCP endpoint: `https://fulfillment-review.allensaji.dev/mcp`
- Health: <https://fulfillment-review.allensaji.dev/health>
- Synthetic test order: `ORD-1042`

The MCP endpoint is not a webpage. Add it to a client that supports remote Streamable HTTP MCP servers:

```json
{
  "mcpServers": {
    "fulfillment-review": {
      "type": "streamable-http",
      "url": "https://fulfillment-review.allensaji.dev/mcp"
    }
  }
}
```

Then submit this request:

```text
Use only the fulfillment-review MCP tools.

Our order-management system has flagged ORD-1042 as being on a
partial-fulfillment hold.

Investigate the hold, present every source-supported option with both
its delivery-date and shipping-cost effects, create or return the
human-review escalation, and read the persisted case back.

Do not rank, recommend, select, or execute an option.

Report the evidence version, available options, review case ID, case
status, and whether any commerce state changed.
```

Expected result:

- One missing `SKU-WALNUT-STAND`
- Two source-supported options with date and cost effects
- No option ranked, recommended, or selected
- Review-case status `PENDING_HUMAN_REVIEW`
- No inventory, reservation, routing, order, or shipment state changed

This is a shared synthetic scenario. The review case may already exist, in which case escalation creation returns `created: false` and the same case ID. This is expected idempotent behavior.

## Workflow

![Workflow diagram showing four MCP tools from hold investigation to human review](docs/fulfillment-review-workflow.png)

The accessible sequence is: investigate the hold, preview options from the same evidence version, create the escalation, read it back, then hand it to a human reviewer.

The evidence version is a SHA-256 digest of canonical source data. Preview and escalation calls fail closed when that version is stale. The escalation tool accepts only an order ID and evidence version; the server reconstructs the evidence and options instead of trusting model-authored case content.

## MCP tools

| Tool                             | Effect                     | Purpose                                                              |
| -------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `investigate_fulfillment_hold`   | Read-only                  | Gather order, reservation, inventory, quote, and hold evidence.      |
| `preview_fulfillment_options`    | Read-only                  | Return source-supported options with both date and cost effects.     |
| `create_human_review_escalation` | Additive, idempotent write | Persist or return one canonical review case for an evidence version. |
| `get_human_review_escalation`    | Read-only                  | Read back the exact persisted case for verification.                 |

The create tool is the only write. Its MCP annotations mark it as non-destructive and idempotent. All tools operate in a closed domain.

Tool discovery stays below a 10 KiB wire-response budget for constrained MCP hosts. The server advertises strict input schemas and validates every structured result against its full internal Zod schema before returning it, without embedding the deeply nested result schemas in `tools/list`.

## Synthetic scenario

The included order, `ORD-1042`, is partially reserved at a Bengaluru warehouse. One line item is unavailable there. The source snapshot supports two alternatives:

- One complete shipment from Mumbai, arriving one day after the promised date for INR 100.00 more than the current plan.
- A Bengaluru and Hyderabad split, arriving on the promised date for INR 115.00 more than the current plan.

Both are facts, not recommendations. A human reviewer owns the tradeoff.
Option IDs are sorted only for reproducible output; their order has no preference meaning.

## Architecture

![Component architecture showing transport, MCP tools, domain logic, and storage boundaries](docs/fulfillment-review-architecture.png)

`src/http.ts` owns transport and request security. `src/server.ts` and `src/tools/` own the MCP boundary. `src/domain/` owns evidence, versioning, option feasibility, and review-case invariants. `src/infrastructure/` provides the immutable commerce source and migration-backed PostgreSQL review cases.

The domain layer does not know about HTTP, MCP, or PostgreSQL. The commerce source exposes no mutation methods. PostgreSQL stores only review cases, and the application exposes no update or delete operation.

## Requirements

- Node.js 24 LTS
- npm 11 or later
- Docker with Compose for the local PostgreSQL service

All direct dependencies are pinned and the lockfile is committed.

## Run locally

```bash
cp .env.example .env
docker compose up --build --detach
```

The default endpoints are:

- MCP: `http://127.0.0.1:3000/mcp`
- Health: `http://127.0.0.1:3000/health`

Run the complete four-tool smoke test in another terminal:

```bash
npm run smoke -- http://127.0.0.1:3000/mcp
```

The smoke script uses the official MCP client, validates every structured result, creates an escalation, and reads it back.

For host-based development, start only PostgreSQL and point the Node process at the published loopback port:

```bash
docker compose up --detach postgres
npm ci
DATABASE_URL=postgresql://fulfillment_review:replace-with-a-random-alphanumeric-password@127.0.0.1:5432/fulfillment_review npm run dev
```

## Local MCP client configuration

```json
{
  "mcpServers": {
    "fulfillment-review": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

List tools with the official MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
```

## Configuration

| Variable               | Default               | Description                                                                                                         |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `HOST`                 | `127.0.0.1`           | HTTP bind address.                                                                                                  |
| `PORT`                 | `3000`                | HTTP port.                                                                                                          |
| `DATABASE_URL`         | Required              | PostgreSQL connection URL. It is validated at startup and never logged.                                             |
| `ALLOWED_HOSTS`        | `localhost,127.0.0.1` | Allowed Host header hostnames without ports.                                                                        |
| `ALLOWED_ORIGIN_HOSTS` | `localhost,127.0.0.1` | Allowed Origin hostnames without schemes or ports. Requests without Origin are allowed for non-browser MCP clients. |
| `LOG_LEVEL`            | `info`                | `debug`, `info`, `warn`, or `error`.                                                                                |

Configuration is validated before the server starts. Logs are structured JSON and exclude request bodies, evidence payloads, environment values, database paths, and secrets.

## Verification

```bash
docker compose up --detach postgres
DATABASE_URL=postgresql://fulfillment_review:replace-with-a-random-alphanumeric-password@127.0.0.1:5432/fulfillment_review npm run verify
```

This runs:

1. Prettier check
2. ESLint with zero warnings
3. Strict TypeScript checking
4. Unit, integration, transport, and MCP end-to-end tests
5. V8 coverage with 95 percent global thresholds
6. Production TypeScript build

The test suite covers deterministic hashing, missing inventory, unsupported or incomplete splits, date and cost deltas, stale evidence, migration-backed PostgreSQL persistence, concurrent idempotent creation, exact MCP annotations, the tool-discovery response budget, arbitrary-field rejection, sanitized errors, Host and Origin validation, body limits, health checks, and the complete four-tool workflow.

Release verification also ran the hosted four-tool workflow through an independent AI MCP host. The host carried the exact evidence version across calls, presented both options without ranking or selection, created or returned the canonical escalation, read the stored case back, and reported no commerce-state change.

## Container

```bash
cp .env.example .env
docker compose up --build --detach
```

The application image uses Node.js 24, runs as a non-root user with a read-only filesystem, and includes a health check. Compose runs PostgreSQL 17 on a private service network with a persistent named volume and publishes both service ports to loopback only.

For a remote deployment, terminate TLS at a reverse proxy, keep the application and PostgreSQL ports private, preserve the public Host header, configure the exact public hostname allowlists, use a generated database password, and persist the PostgreSQL data volume.

## Security and production boundary

This repository is a bounded demonstration using synthetic data. Authentication is intentionally excluded. A production commerce integration would additionally require:

- OAuth and tenant isolation
- authorization for each merchant and order
- managed secret storage
- external rate limiting and abuse controls
- real commerce-source credentials and availability handling
- database backup, migration, retention, and deletion policies
- operational metrics and alerting

The current public endpoint can write at most one review case for each finite order and evidence version. Repeated requests return the existing record.

## Assumptions and exclusions

This demonstration assumes:

- The commerce source is authoritative for order, reservation, inventory, split-support, and shipping-quote data.
- Upstream systems have already calculated shipping costs and estimated delivery dates.
- Any source-data change produces a new evidence version before another workflow step can continue.
- A human reviewer acts on the recorded case through a separate operations system.

The repository intentionally excludes:

- inventory, reservation, routing, and shipment mutations
- option ranking, recommendation, selection, or execution
- review approval and resolution workflows
- live commerce-provider integrations and customer data
- authentication, tenant management, and a frontend

## Design decisions

- No embedded model call: the MCP host performs reasoning; the server owns facts and deterministic calculations.
- No ORM: one migration-backed append-only table and one transactional create-or-get operation are clearer as direct parameterized SQL.
- No web framework: Node HTTP plus the official MCP Node adapter covers the transport surface.
- No mutable commerce adapter: unsafe operations are absent rather than guarded by prompt instructions.
- Integer minor currency units: cost calculations avoid floating-point ambiguity.
- Fixed synthetic dates: tests and demonstrations remain reproducible.

## License

MIT
