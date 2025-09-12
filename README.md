# Todoist MCP Shim (Read + Write)

This is a small **remote MCP server** that lets ChatGPT (and other MCP clients) **read and write** your Todoist data.
It implements the two **required** tools for ChatGPT connectors — `search` and `fetch` — plus `add-task`.

## What you can do

- **Read**: search tasks using Todoist **filter** syntax (e.g., `next 7 days & project: Volunteers`).
- **Fetch**: load full JSON for a task or project by ID.
- **Write**: create tasks (`add-task`).

## Prerequisites

- **Node.js 18+**
- A Todoist **API token** (Todoist → Settings → Integrations → Developer → API token). Set it as `TODOIST_API_TOKEN`.

## Run locally

```bash
npm install
TODOIST_API_TOKEN=YOUR_TOKEN node index.js
```

The server will run on `http://localhost:8787/mcp`.

## Deploy (two easy options)

### Option A: Replit (fastest, in-browser)

1. Go to **replit.com** → Create Repl → **Node.js**.
2. Click the **Files** panel and **Upload** the contents of this folder (or copy/paste the files).
3. Open the **Packages** tab to confirm dependencies are installed (or run `npm install` in the shell).
4. Click the lock icon **"Secrets"** → add a new secret:
   - **Key:** `TODOIST_API_TOKEN`
   - **Value:** (paste your Todoist API token)
5. Click **Run**. Replit shows a public URL like `https://your-repl-name.your-user.repl.co`.
6. Your MCP endpoint is `https://.../mcp` (append `/mcp` to that URL).

### Option B: Render (single-instance web service)

1. Go to **render.com** → **New** → **Web Service**.
2. Connect a GitHub repo with these files (or create a repo and push these files).
3. **Build Command:** `npm install`  
   **Start Command:** `node index.js`
4. **Environment** → add variable `TODOIST_API_TOKEN` with your token.
5. **Instance count:** 1 (keeps session stable). Deploy.
6. Copy your `onrender.com` URL and append `/mcp` (e.g., `https://my-todoist-shim.onrender.com/mcp`).

## Connect to ChatGPT (custom connector)

In ChatGPT:
- Profile → **Settings** → **Connectors** → **Add custom (MCP)**.
- Enter your MCP URL (e.g., `https://.../mcp`).
- You should **not** see “search action not found.” You will see tools: `search`, `fetch`, and `add-task`.

## Example prompts (after connecting)

- “Search Todoist for `next 7 days & project: Volunteers`, then summarize by day.”
- “Fetch task `<id>`.”
- “Add a task ‘Call venue’ in project `<project_id>` due `next Tuesday 10am`.”

## Notes

- This server uses the **Streamable HTTP** transport with **session management** per the MCP SDK examples.
- For production, restrict CORS (`origin`) to your domain(s) instead of `*`.
- If you want to deploy on other platforms (Fly.io, Railway, Docker, etc.), the only requirement is a **single long‑running instance** so sessions stay stable.

---

### References

- ChatGPT connectors require **`search`** and **`fetch`** tools: OpenAI Help Center.
- MCP Streamable HTTP transport & sessions: MCP TypeScript SDK README / Spec.
- Todoist “Get Tasks by Filter” (`/api/v1/tasks/filter`) and auth details: Todoist API v1 docs.
