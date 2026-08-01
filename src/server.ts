import { McpServer } from "@modelcontextprotocol/server";

import {
  registerFulfillmentTools,
  type ToolDependencies,
} from "./tools/register-tools.js";

export const SERVER_NAME = "fulfillment-review-mcp";
export const SERVER_VERSION = "0.1.0";

export function buildMcpServer(dependencies: ToolDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "Use investigate_fulfillment_hold first.",
        "Pass its exact evidenceVersion to preview_fulfillment_options.",
        "Present all available delivery-date and shipping-cost effects to a human reviewer without ranking or selecting an option.",
        "Use create_human_review_escalation only to persist the canonical review case, then verify it with get_human_review_escalation.",
        "Never claim that this server changed inventory, reservations, routing, or shipments.",
      ].join(" "),
    },
  );

  registerFulfillmentTools(server, dependencies);
  return server;
}
