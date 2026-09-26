import { describe, it, expect } from "vitest";
import { redactEnv, parseMcpConfig } from "../src/discover/fromMcpConfig.js";
import { redactSecrets, redactArgString, redactUrlString } from "../src/utils/redact.js";
import { restoreSecrets } from "../src/apply/applyConfig.js";

describe("redactEnv", () => {
  it("replaces env values with *** so secrets never appear in JSON", () => {
    const config = {
      mcpServers: {
        gmail: {
          command: "npx",
          args: ["-y", "fake-mcp"],
          env: {
            API_KEY: "super-secret-key-xyz",
            TOKEN: "tok_live_abc123",
          },
        },
      },
    };
    const redacted = redactEnv(config);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("super-secret-key-xyz");
    expect(json).not.toContain("tok_live_abc123");
    expect(json).toContain("***");
    expect(redacted.mcpServers.gmail.env.API_KEY).toBe("***");
    // original untouched
    expect(config.mcpServers.gmail.env.API_KEY).toBe("super-secret-key-xyz");
  });
});

describe("parseMcpConfig", () => {
  it("parses Cursor-style mcpServers stdio entries", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        demo: {
          command: "node",
          args: ["server.js"],
          env: { FOO: "bar" },
        },
        remote: {
          url: "https://example.com/mcp",
        },
      },
    });
    expect(parsed).toHaveLength(2);
    const demo = parsed.find((p) => p.name === "demo")!;
    expect(demo.kind).toBe("stdio");
    expect(demo.command).toBe("node");
    expect(demo.args).toEqual(["server.js"]);
    const remote = parsed.find((p) => p.name === "remote")!;
    expect(remote.kind).toBe("remote");
  });

  it("throws on invalid shape", () => {
    expect(() => parseMcpConfig({})).toThrow(/mcpServers/);
  });
});

describe("redactArgString", () => {
  it("redacts --api-key=value patterns", () => {
    expect(redactArgString("--api-key=secret123")).toBe("--api-key=<from-original>");
    expect(redactArgString("--api_key=secret123")).toBe("--api_key=<from-original>");
    expect(redactArgString("--token=tok_xyz")).toBe("--token=<from-original>");
    expect(redactArgString("--password=pass123")).toBe("--password=<from-original>");
  });

  it("leaves non-secret flags alone", () => {
    expect(redactArgString("--port=3000")).toBe("--port=3000");
    expect(redactArgString("--host=localhost")).toBe("--host=localhost");
  });
});

describe("redactUrlString", () => {
  it("redacts userinfo in URLs", () => {
    expect(redactUrlString("https://user:pass@example.com")).toBe("https://<from-original>@example.com");
    expect(redactUrlString("http://admin:secret@localhost:8080")).toBe("http://<from-original>@localhost:8080");
  });

  it("redacts secret query parameters", () => {
    expect(redactUrlString("https://api.example.com?token=xyz")).toBe("https://api.example.com?token=<from-original>");
    expect(redactUrlString("https://api.example.com?api_key=abc&foo=bar")).toBe("https://api.example.com?api_key=<from-original>&foo=bar");
    expect(redactUrlString("https://api.example.com?foo=bar&password=secret")).toBe("https://api.example.com?foo=bar&password=<from-original>");
  });

  it("leaves non-secret URLs alone", () => {
    expect(redactUrlString("https://example.com")).toBe("https://example.com");
    expect(redactUrlString("https://example.com?foo=bar&baz=qux")).toBe("https://example.com?foo=bar&baz=qux");
  });
});

describe("redactSecrets with args and URLs", () => {
  it("redacts args with --flag=value patterns", () => {
    const config = {
      mcpServers: {
        server1: {
          command: "node",
          args: ["start", "--api-key=secret123", "--port=3000"],
        },
      },
    };
    const redacted = redactSecrets(config) as any;
    expect(redacted.mcpServers.server1.args[1]).toBe("--api-key=<from-original>");
    expect(redacted.mcpServers.server1.args[2]).toBe("--port=3000");
  });

  it("redacts args with two-element flag-value form", () => {
    const config = {
      mcpServers: {
        server1: {
          command: "node",
          args: ["start", "--token", "tok_xyz", "--port", "3000"],
        },
      },
    };
    const redacted = redactSecrets(config) as any;
    expect(redacted.mcpServers.server1.args[1]).toBe("--token");
    expect(redacted.mcpServers.server1.args[2]).toBe("<from-original>");
    expect(redacted.mcpServers.server1.args[3]).toBe("--port");
    expect(redacted.mcpServers.server1.args[4]).toBe("3000");
  });

  it("redacts URL secrets", () => {
    const config = {
      mcpServers: {
        server1: {
          url: "https://user:pass@example.com?token=xyz&foo=bar",
        },
      },
    };
    const redacted = redactSecrets(config) as any;
    expect(redacted.mcpServers.server1.url).toBe("https://<from-original>@example.com?token=<from-original>&foo=bar");
  });

  it("redacts nested env and headers", () => {
    const config = {
      mcpServers: {
        server1: {
          command: "node",
          env: { API_KEY: "secret" },
          headers: { Authorization: "Bearer token123" },
        },
      },
    };
    const redacted = redactSecrets(config) as any;
    expect(redacted.mcpServers.server1.env.API_KEY).toBe("<from-original>");
    expect(redacted.mcpServers.server1.headers.Authorization).toBe("<from-original>");
  });
});

describe("restoreSecrets with embedded placeholders", () => {
  it("restores args with --flag=<from-original> patterns", () => {
    const proposed = {
      mcpServers: {
        server1: {
          command: "node",
          args: ["start", "--api-key=<from-original>", "--port=3000"],
        },
      },
    };
    const original = {
      mcpServers: {
        server1: {
          command: "node",
          args: ["start", "--api-key=secret123", "--port=3000"],
        },
      },
    };
    const { result, errors } = restoreSecrets(proposed, original);
    expect(errors).toHaveLength(0);
    const restored = result as any;
    expect(restored.mcpServers.server1.args[1]).toBe("--api-key=secret123");
  });

  it("restores args with two-element form", () => {
    const proposed = {
      mcpServers: {
        server1: {
          command: "node",
          args: ["start", "--token", "<from-original>", "--port", "3000"],
        },
      },
    };
    const original = {
      mcpServers: {
        server1: {
          command: "node",
          args: ["start", "--token", "tok_xyz", "--port", "3000"],
        },
      },
    };
    const { result, errors } = restoreSecrets(proposed, original);
    expect(errors).toHaveLength(0);
    const restored = result as any;
    expect(restored.mcpServers.server1.args[2]).toBe("tok_xyz");
  });

  it("restores URL userinfo and query params", () => {
    const proposed = {
      mcpServers: {
        server1: {
          url: "https://<from-original>@example.com?token=<from-original>&foo=bar",
        },
      },
    };
    const original = {
      mcpServers: {
        server1: {
          url: "https://user:pass@example.com?token=xyz&foo=bar",
        },
      },
    };
    const { result, errors } = restoreSecrets(proposed, original);
    expect(errors).toHaveLength(0);
    const restored = result as any;
    expect(restored.mcpServers.server1.url).toBe(
      "https://user:pass@example.com?token=xyz&foo=bar"
    );
  });

  it("returns errors when original values are missing", () => {
    const proposed = {
      mcpServers: {
        server1: {
          args: ["--api-key=<from-original>"],
        },
      },
    };
    const original = {
      mcpServers: {
        server1: {
          args: ["--different-flag=value"],
        },
      },
    };
    const { result, errors } = restoreSecrets(proposed, original);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Cannot restore --api-key");
  });
});
