import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const TODOIST_API = "https://api.todoist.com/api/v1";
const TOKEN =
  process.env.TODOIST_API_TOKEN || process.env.TODOIST_TOKEN || process.env.TODOIST;

if (!TOKEN) {
  console.error("[ERROR] Set TODOIST_API_TOKEN in the environment");
  process.exit(1);
}

function getServer() {
  const server = new McpServer({ name: "todoist-mcp-shim", version: "1.0.1" });

  // --- search ---
  server.registerTool(
    "search",
    {
      title: "Search Todoist",
      description:
        "Search tasks using Todoist filter syntax (e.g. 'next 7 days & project: Volunteers')",
      inputSchema: {
        query: z.string().describe(
          'Todoist filter, e.g. "next 7 days & project: Volunteers"'
        ),
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

  // --- fetch ---
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

  // --- add-task (optional write) ---
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

// IMPORTANT: allow any headers; don't restrict allowedHeaders (fixes connector CORS/preflight)
app.use(
  cors({
    origin: true,
    credentials: false,
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

// Preflight for /mcp
app.options("/mcp", cors());

// Health checks
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Friendly GET for /mcp without a session (connector probes this)
const transports = {};
app.get("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (!sid) {
    res.status(200).json({ status: "ready", message: "Use POST initialize to start an MCP session" });
    return;
  }
  const transport = transports[sid];
  if (!transport) return res.status(400).send("Invalid or missing session ID");
  await transport.handleRequest(req, res);
});

// DELETE with/without session
app.delete("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  const transport = sid ? transports[sid] : undefined;
  if (!transport) return res.status(200).send("ok");
  await transport.handleRequest(req, res);
});

// POST: initialize or continue
app.post("/mcp", async (req, res) => {
  const existingId = req.headers["mcp-session-id"];
  let transport = existingId ? transports[existingId] : undefined;

  if (existingId && transport) {
    // continue
  } else if (!existingId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    transport.onsessioninitialized = (sid) => (transports[sid] = transport);
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = getServer();
    await server.connect(transport);
  } else {
    res
      .status(400)
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Todoist MCP shim listening on port ${PORT}`));
