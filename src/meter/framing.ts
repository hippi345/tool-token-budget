import type { Tool } from "../types.js";

/** Client serialization mode for token counting (separate from emit profile). */
export type ClientFramingProfile =
  | "cursor-catalog"
  | "cursor-full"
  | "anthropic-tools"
  | "openai-tools"
  | "vscode-flat"
  | "gemini-functions"
  | "claude-full-inject";

export function framingLabel(profile: ClientFramingProfile): string {
  return profile;
}

/** Compact Cursor catalog heuristic: tool names + short schema refs (experimental). */
export function buildCursorCatalogPayload(tools: Tool[]): string {
  const entries = tools.map((t) => {
    const schemaRef =
      t.inputSchema && typeof t.inputSchema === "object"
        ? Object.keys(t.inputSchema as object).join(",") || "schema"
        : "schema";
    return `${t.name}@${schemaRef}`;
  });
  return JSON.stringify({ catalog: entries });
}

/** Worst-case full inject (legacy meterTool payload) for one tool. */
export function buildFullInjectPayload(tool: Tool): string {
  const schemaJson = JSON.stringify(tool.inputSchema ?? {});
  return `${tool.name}\n${tool.description ?? ""}\n${schemaJson}`;
}

/** Anthropic API tools[] shape for one tool. */
export function buildAnthropicToolPayload(tool: Tool): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema ?? {},
  });
}

/** OpenAI Chat Completions tools[] entry (official wrapper). */
export function buildOpenAiToolPayload(tool: Tool): string {
  return JSON.stringify({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? {},
    },
  });
}

/** VS Code / legacy flat function shape (no type wrapper). */
export function buildVscodeFlatToolPayload(tool: Tool): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema ?? {},
  });
}

/** Single Gemini function declaration object. */
export function buildGeminiFunctionDeclaration(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema ?? {},
  };
}

/** Gemini API request tools wrapper (count once per request). */
export function buildGeminiToolsRequestPayload(tools: Tool[]): string {
  const functionDeclarations = tools.map(buildGeminiFunctionDeclaration);
  return JSON.stringify({
    tools: [{ functionDeclarations }],
  });
}

export function buildFramedText(
  tool: Tool,
  framing: ClientFramingProfile,
  allToolsForCatalog?: Tool[]
): string {
  switch (framing) {
    case "cursor-catalog":
      return buildCursorCatalogPayload(allToolsForCatalog ?? [tool]);
    case "cursor-full":
    case "claude-full-inject":
      return buildFullInjectPayload(tool);
    case "anthropic-tools":
      return buildAnthropicToolPayload(tool);
    case "openai-tools":
      return buildOpenAiToolPayload(tool);
    case "vscode-flat":
      return buildVscodeFlatToolPayload(tool);
    case "gemini-functions":
      return JSON.stringify(buildGeminiFunctionDeclaration(tool));
    default:
      return buildFullInjectPayload(tool);
  }
}
