#!/usr/bin/env node
/**
 * Minimal stdio MCP stub: responds to initialize + tools/list.
 * Not a full SDK server — just enough JSON-RPC for schema-budget smoke.
 */
import { createInterface } from "node:readline";

const tools = [
  {
    name: "stub_ping",
    description: "Stub ping tool",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stub_echo",
    description: "Stub echo tool",
    inputSchema: {
      type: "object",
      properties: { msg: { type: "string" } },
    },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
