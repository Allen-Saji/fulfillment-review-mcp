import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import {
  createEscalationOutputSchema,
  getEscalationOutputSchema,
  investigateOutputSchema,
  previewOutputSchema,
} from "../src/tools/schemas.js";
import { SYNTHETIC_ORDER_ID } from "../src/infrastructure/synthetic-commerce.js";

const endpoint = new URL(
  process.argv[2] ?? process.env["MCP_URL"] ?? "http://127.0.0.1:3000/mcp",
);
const client = new Client({
  name: "fulfillment-review-smoke",
  version: "0.1.0",
});

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  process.stdout.write(`Tools: ${toolNames.join(", ")}\n`);

  const investigationCall = await client.callTool({
    name: "investigate_fulfillment_hold",
    arguments: { orderId: SYNTHETIC_ORDER_ID },
  });
  const investigation = investigateOutputSchema.parse(
    investigationCall.structuredContent,
  );

  const previewCall = await client.callTool({
    name: "preview_fulfillment_options",
    arguments: {
      orderId: SYNTHETIC_ORDER_ID,
      evidenceVersion: investigation.evidenceVersion,
    },
  });
  const preview = previewOutputSchema.parse(previewCall.structuredContent);

  const createCall = await client.callTool({
    name: "create_human_review_escalation",
    arguments: {
      orderId: SYNTHETIC_ORDER_ID,
      evidenceVersion: investigation.evidenceVersion,
    },
  });
  const created = createEscalationOutputSchema.parse(
    createCall.structuredContent,
  );

  const getCall = await client.callTool({
    name: "get_human_review_escalation",
    arguments: { reviewCaseId: created.reviewCaseId },
  });
  const reviewCase = getEscalationOutputSchema.parse(getCall.structuredContent);

  process.stdout.write(
    `${JSON.stringify(
      {
        endpoint: endpoint.href,
        orderId: investigation.orderId,
        evidenceVersion: investigation.evidenceVersion,
        availableOptions: preview.availableOptions.length,
        reviewCaseId: reviewCase.id,
        status: reviewCase.status,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
}
