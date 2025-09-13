import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";


const TODOIST_API = "https://api.todoist.com/api/v1";
const TOKEN =
  process.env.TODOIST_API_TOKEN ||
  process.env.TODOIST_TOKEN ||
  process.env.TODOIST;

if (!TOKEN) {
  console.error("[ERROR] Set TODOIST_API_TOKEN in the environment");
  process.exit(1);
}

function getServer() {
  const server = new McpServer({ name: "todoist-mcp-shim", version: "1.0.4" });

  // ---- search ----
  server.registerTool(
    "search",
    {
      title: "Search Todoist",
      description:
        "Search tasks using Todoist filter syntax (e.g. 'next 7 days & project: Volunteers')",
      inputSchema: {
        query: z.string().describe('Todoist filter, e.g. "next 7 days & project: Volunteers"'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query, limit = 50 }) => {
      const url = new URL(`${TODOIST_API}/tasks/filter`);
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(limit));
      const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const text = await res.text();
      if (!res.ok) return { content: [{ type: "text", text: `Todoist error ${res.status}: ${text}` }] };

      const data = JSON.parse(text);
      const results = Array.isArray(data?.results) ? data.results : [];
      const links = results.map((t) => ({
        type: "resource_link",
        uri: `todoist://task/${t.id}`,
        name: t.content || `task ${t.id}`,
        mimeType: "application/json",
        description: `${t.due?.date ?? "no date"} • project ${t.project_id}`,
      }));
      return { content: [{ type: "text", text: `Found ${results.length} task(s) for "${query}".` }, ...links] };
    }
  );

  // ---- fetch ----
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
      if (!res.ok) return { content: [{ type: "text", text: `Todoist error ${res.status}: ${text}` }] };
      return { content: [{ type: "text", text }] };
    }
  );

  // ---- add-task ----
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
      if (!res.ok) return { content: [{ type: "text", text: `Todoist error ${res.status}: ${text}` }] };
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Permissive CORS for browser-based clients (ChatGPT)
// - expose Mcp-Session-Id so the client can maintain sessions
// - reflect requested headers so preflight passes
app.use(
  cors({
    origin: true,
    credentials: false,
    exposedHeaders: ["Mcp-Session-Id"],
  })
);
app.options("/mcp*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  const reqHeaders = req.header("Access-Control-Request-Headers");
  if (reqHeaders) res.header("Access-Control-Allow-Headers", reqHeaders);
  res.header("Access-Control-Max-Age", "86400");
  res.status(204).send();
});

// Health
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

const transports = {};
function makeTransport() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  transport.onsessioninitialized = (sid) => (transports[sid] = transport);
  transport.onclose = () => {
    if (transport.sessionId) delete transports[transport.sessionId];
  };
  const server = getServer();
  server.connect(transport);
  return transport;
}

// Helper: ensure Accept header has both types (spec requires it)
function ensureAcceptHeader(req) {
  const raw = String(req.headers["accept"] || "");
  if (!raw.includes("application/json") || !raw.includes("text/event-stream")) {
    const parts = [];
    if (!raw.includes("application/json")) parts.push("application/json");
    if (!raw.includes("text/event-stream")) parts.push("text/event-stream");
    req.headers["accept"] = (raw ? raw + ", " : "") + parts.join(", ");
  }
}

// GET /mcp
// - If Accept includes SSE, stream.
// - If not (browser probe), return a friendly JSON so ChatGPT’s validator doesn’t fail.
app.get("/mcp", async (req, res) => {
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/event-stream")) {
    ensureAcceptHeader(req);
    let transport = req.headers["mcp-session-id"]
      ? transports[req.headers["mcp-session-id"]]
      : undefined;
    if (!transport) transport = makeTransport();
    await transport.handleRequest(req, res);
    return;
  }
  res.status(200).json({ status: "ready", tools: ["search", "fetch", "add-task"] });
});

// POST /mcp (JSON-RPC)
app.post("/mcp", async (req, res) => {
  ensureAcceptHeader(req); // <-- critical workaround for ChatGPT’s first POST
  let transport = req.headers["mcp-session-id"]
    ? transports[req.headers["mcp-session-id"]]
    : undefined;
  if (!transport) transport = makeTransport();
  await transport.handleRequest(req, res, req.body);
});

// DELETE /mcp (close)
app.delete("/mcp", async (req, res) => {
  const transport = req.headers["mcp-session-id"]
    ? transports[req.headers["mcp-session-id"]]
    : undefined;
  if (!transport) return res.status(200).send("ok");
  await transport.handleRequest(req, res);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Todoist MCP shim listening on port ${PORT}`));
