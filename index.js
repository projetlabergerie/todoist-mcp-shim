import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const TODOIST_API = "https://api.todoist.com/api/v1";
const TOKEN = process.env.TODOIST_API_TOKEN || process.env.TODOIST_TOKEN || process.env.TODOIST;
if (!TOKEN) {
  console.error("[ERROR] You must set TODOIST_API_TOKEN in the environment.");
  process.exit(1);
}

function getServer() {
  const server = new McpServer({ name: "todoist-mcp-shim", version: "1.0.0" });

  // --- Tool: search ---
  server.registerTool(
    "search",
    {
      title: "Search Todoist",
      description: "Search tasks using Todoist filter syntax (e.g. 'next 7 days & project: Volunteers')",
      inputSchema: {
        query: z.string().describe('Todoist filter, e.g. "next 7 days & project: Volunteers"'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query, limit = 50 }) => {
      const url = new URL(`${TODOIST_API}/tasks/filter`);
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(limit));

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      const text = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Todoist error ${res.status}: ${text}` }] };
      }
      const data = JSON.parse(text);
      const results = Array.isArray(data?.results) ? data.results : [];

      const links = results.map((t) => ({
        type: "resource_link",
        uri: `todoist://task/${t.id}`,
        name: t.content || `task ${t.id}`,
        mimeType: "application/json",
        description: `${t.due?.date ?? "no date"} • project ${t.project_id}`,
      }));

      const summary = `Found ${results.length} task(s) for "${query}".`;
      return { content: [{ type: "text", text: summary }, ...links] };
    }
  );

  // --- Tool: fetch ---
  server.registerTool(
    "fetch",
    {
      title: "Fetch Todoist entity",
      description: "Fetch a Todoist task or project by ID",
      inputSchema: { kind: z.enum(["task", "project"]), id: z.string() },
    },
    async ({ kind, id }) => {
      const endpoint = kind === "task" ? `/tasks/${id}` : `/projects/${id}`;
      const res = await fetch(`${TODOIST_API}${endpoint}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const text = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Todoist error ${res.status}: ${text}` }] };
      }
      return { content: [{ type: "text", text }] }; // JSON as text
    }
  );

  // --- Optional: add-task ---
  server.registerTool(
    "add-task",
    {
      title: "Add task",
      description: "Create a new Todoist task",
      inputSchema: {
        content: z.string(),
        project_id: z.string().optional(),
        due_string: z.string().optional(),
      },
    },
    async ({ content, project_id, due_string }) => {
      const res = await fetch(`${TODOIST_API}/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content, project_id, due_string }),
      });
      const text = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Todoist error ${res.status}: ${text}` }] };
      }
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

// --- Express app + Streamable HTTP transport (stateful) ---
const app = express();
app.use(express.json());

// CORS: expose Mcp-Session-Id header per MCP SDK docs
app.use(
  cors({
    origin: "*", // For production, restrict this to your domain(s)
    exposedHeaders: ["Mcp-Session-Id"],
    allowedHeaders: ["Content-Type", "mcp-session-id", "Mcp-Session-Id"],
  })
);

// Keep transports keyed by session id
const transports = {};

// Unified handler for GET/DELETE (SSE notifications & session termination)
const handleSessionRequest = async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// POST: initialize or reuse a session, then handle the request
app.post("/mcp", async (req, res) => {
  const existingId = req.headers["mcp-session-id"];
  let transport = existingId ? transports[existingId] : undefined;

  if (existingId && transport) {
    // Continue existing session
  } else if (!existingId && isInitializeRequest(req.body)) {
    // Start a new session
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // If running locally, consider enabling DNS rebinding protection:
      // enableDnsRebindingProtection: true,
      // allowedHosts: ["127.0.0.1", "localhost"],
    });

    // Store/remove the transport when session lifecycle changes
    transport.onsessioninitialized = (sid) => {
      transports[sid] = transport;
    };
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    // Connect a fresh MCP server instance for this transport
    const server = getServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Todoist MCP shim listening on port ${PORT}`);
});
