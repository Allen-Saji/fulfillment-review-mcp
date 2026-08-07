# AI worklog

## Tools and model selection

- OpenAI Codex with `gpt-5.6-sol` was used for planning, implementation, debugging, testing, review, and documentation.
- One model was kept across the bounded workflow so architectural constraints and client feedback remained consistent through implementation and review.
- Official Model Context Protocol TypeScript SDK documentation and published package types were used as primary references for the server, client, Streamable HTTP, schema, and annotation APIs.
- The npm registry and official Node.js release information were used to verify compatible pinned versions.

No model call is embedded in the server. An MCP host supplies the reasoning layer, while the server owns source facts, deterministic calculations, validation, and persistence.

## Planning and decomposition

The work was divided into the following stages:

1. Convert the approved product boundary into invariants: no commerce mutation, no ranking, and human ownership of the decision.
2. Define one synthetic source snapshot and four MCP tool contracts.
3. Implement evidence versioning, option feasibility, date and cost effects, and immutable escalation storage.
4. Add the Streamable HTTP boundary and operational protections.
5. Verify domain behavior, tool contracts, persistence, transport behavior, and the complete MCP workflow.
6. Review the public repository for scope, documentation, private context, and secret exposure.

## Human and AI responsibilities

Human responsibilities:

- Selected the commerce problem and confirmed its value and scope with the client.
- Set the final product and safety boundaries.
- Decided which suggestions to accept, change, or reject.
- Reviewed behavior, tests, documentation, and release readiness.
- Retained responsibility for deployment, demonstration, and submission.

AI-assisted work:

- Proposed domain, persistence, tool, and transport boundaries.
- Implemented deterministic evidence hashing and option calculation.
- Implemented PostgreSQL idempotency, migrations, and MCP tool contracts.
- Added negative-path, transport, persistence, and end-to-end tests.
- Drafted and revised usage, architecture, and deployment documentation.

## Important instructions supplied to AI

The recurring instructions and context included:

- Treat the human-review escalation as the only permitted write.
- Never reallocate inventory, reroute fulfillment, create or modify shipments, or change reservation state.
- Present delivery-date and shipping-cost effects together without ranking or selecting an option.
- Include a split-shipment option only when the source snapshot explicitly supports it.
- Keep the implementation to one coherent workflow and avoid a frontend, authentication system, or complete commerce backend.
- Derive persisted evidence and options on the server instead of trusting model-authored case content.

These are concise summaries rather than a private conversation transcript.

## Rejected and corrected suggestions

An early workflow proposal allowed a reallocation to be previewed and then executed after operator approval. That approach was rejected after client review because execution would cross the assignment's safety boundary. The final server cannot mutate commerce state and ends with an evidence-backed case for human review.

A model-supplied escalation payload was also rejected. The create tool accepts only `orderId` and `evidenceVersion`; the server reconstructs and validates the complete case before persistence.

## Verification

AI-assisted work was checked through formatting, linting, strict type checking, automated tests, coverage thresholds, a production build, dependency audit, container build, and a live MCP client smoke test. Tests cover both expected behavior and failures such as stale evidence, unsupported splits, missing inventory, arbitrary input fields, duplicate writes, invalid hosts and origins, oversized bodies, and storage errors.

The deployed server was also exercised through an independent Codex CLI MCP host. Given the order identifier and the operational goal, the host investigated the hold, carried the returned evidence version into later calls, presented both tradeoffs without choosing one, created or returned the canonical escalation, and read the stored case back. It repeated the read-only preview call once before escalation; the deterministic response was unchanged and the only write remained idempotent. This verified that redundant client behavior does not mutate commerce state or create duplicate review cases.

## Revision after hosted evaluation

The evaluator reported that its hosted MCP probe could not complete because a response exceeded its limit and requested PostgreSQL instead of SQLite. The response limit and PostgreSQL preference were not present in the original assignment, but the storage choice should have been confirmed before implementation.

The live endpoint was measured before changing code. `initialize` returned 654 bytes, while `tools/list` returned 29,624 bytes. Per-tool measurement showed that deeply nested advertised output schemas accounted for most of the discovery payload. The revision keeps strict input schemas in tool discovery, validates full structured results with the same internal Zod schemas, and adds a wire-level regression test requiring `tools/list` to remain at or below 10 KiB.

The SQLite adapter was replaced with a PostgreSQL 17 store. A tracked SQL migration creates the review-case table and database uniqueness constraints. The create-or-get operation uses a transaction and `ON CONFLICT`, including a concurrent-creation test that proves only one canonical case is created. CI now runs the complete suite against a real PostgreSQL service and validates the Compose configuration.

## Remaining risks and unfinished work

- The data source contains one synthetic scenario rather than a live commerce integration.
- Authentication and tenant isolation are intentionally excluded from this bounded demonstration.
- The self-hosted PostgreSQL instance has persistent local storage but no off-server backup or high-availability replica in this bounded demonstration.
- Shipping quotes and delivery estimates are accepted as source facts rather than independently verified.
- A separate operations system and human process would be required to resolve recorded review cases.
- The original asynchronous demonstration predates the PostgreSQL revision; the repository and revised-submission verification are the current technical record.
