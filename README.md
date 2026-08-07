# Vertex Swarm

**Local-first AI coding agent for VS Code.** An agent that reads your workspace, runs terminal commands, plans multi-step work, and streams results in a sidebar chat — with the LLM loop and chat history on your machine. Cloud is only for sign-in and entitlements; you bring your own LLM key.

 
> **Visual preview:** video demo coming soon :
 

## What it does

- **Sidebar chat** — agent UI inside VS Code (Activity Bar → Vertex Swarm)
- **Local worker** — Python backend spawned by the extension over stdio JSON-RPC (no remote agent API for chat)
- **NATS JetStream** — local session / agent state (bundled `nats-server`)
- **IDE tools** — workspace files, terminal, plan/todo, web search (Exa), subagents, human-in-the-loop
- **Deep plan** — multi-stage planning pipeline (`/deep-plan`)
- **Snapshots** — undo-friendly file change history under `~/.vertex-swarm/snapshots/`
- **BYOK** — OpenRouter (default) or any OpenAI-compatible base URL; keys stay in VS Code Secret Storage
- **Hosted auth** — Google OAuth + entitlement JWT via a small cloud service

## Architecture (short)

```
VS Code Extension  ──stdio JSON-RPC──►  Python worker (main_worker)
        │                                      │
        │ spawns                               ├── ~/.vertex-swarm/chats/
        ├── nats-server (localhost)            └── NATS JetStream KV
        │
        └── HTTPS ──► Hosted Auth (entitlement only)
```

Data lives under `~/.vertex-swarm/` (chats, NATS store, snapshots).

## Prerequisites

| Tool | Version / notes |
|------|-----------------|
| [VS Code](https://code.visualstudio.com/) | `^1.93.0` (Cursor works for extension host too) |
| Node.js | 18+ recommended (`npm` for extension + webview) |
| Python | 3.11+ recommended |
| OpenRouter API key | Or another OpenAI-compatible provider URL + key |
| (Optional) Exa API key | For `web_search` |
| (Optional) NATS binary | Bundled under `extension/bin/<platform>/` for packaged builds; required for Production mode |

## Installation

### 1. Clone

```bash
git clone https://github.com/<your-org>/Vertex-swarm.git
cd Vertex-swarm
```

### 2. Backend (local Python worker)

```bash
cd vertex_swarm/backend
python -m venv venv

# Windows
.\venv\Scripts\activate

# macOS / Linux
# source venv/bin/activate

pip install -r requirements.txt
pip install nats-py aiofiles
```

> **Note:** `requirements.txt` includes **Pillow** for image resize-on-send. If the worker fails with `ModuleNotFoundError: No module named 'PIL'`, re-run `pip install -r requirements.txt` inside `vertex_swarm/backend/venv`.

> Development mode expects the venv at `vertex_swarm/backend/venv`. The extension runs `python -m app.main_worker` from that environment.

### 3. Extension + webview

```bash
cd ../extension/frontend
npm install
npm run build

cd ..
npm install
```

Or from `vertex_swarm/`:

```powershell
.\build_extension.ps1
```

That builds the frontend and packages a `.vsix`.

### 4. Run in Extension Development Host

1. Open the `vertex_swarm/extension` folder in VS Code / Cursor.
2. Press **F5** (Run Extension).
3. In the new window: open the **Vertex Swarm** activity-bar view.

### 5. Install from VSIX (optional)

```bash
cd vertex_swarm/extension
npm run package
code --install-extension vertex-swarm-extension-0.0.1.vsix
```

Production mode uses `extension/bin/<platform>/nats-server` and `python-worker` (Windows binaries are already under `bin/win32/`).

## Usage

### First-time setup

1. Open the **Vertex Swarm** sidebar.
2. **Sign in** (hosted OAuth → entitlement JWT stored in Secret Storage).
3. Enter your **LLM API key** (OpenRouter by default) in the sidebar settings / provider UI.
4. Optionally add an **Exa** key for web search.
5. Send a message — the extension starts NATS + the Python worker if needed.

### Settings (`vertexSwarm.*`)

| Setting | Default | Purpose |
|---------|---------|---------|
| `llmBaseUrl` | `https://openrouter.ai/api/v1` | OpenAI-compatible API base |
| `llmModel` | `deepseek/deepseek-v4-flash` | Model id |
| `llmReasoningEnabled` | `false` | Reasoning / thinking mode |
| `llmReasoningEffort` | `low` | `low` \| `medium` \| `high` \| `max` \| `xhigh` |
| `snapshotRetentionDays` | `7` | Snapshot GC window |

Auth broker URL (extension env):

```bash
# vertex_swarm/extension/.env.example
VERTEX_HOSTED_AUTH_URL=https://auth-for-vertex-swarm.onrender.com
# Local auth: http://localhost:8080
```

### Chat & commands

| Action | How |
|--------|-----|
| Open chat | Activity Bar → **Vertex Swarm** |
| Start agent | Command Palette → `Vertex: Start Agent` |
| Deep plan | Prefix a message with `/deep-plan` |
| Recent chats | Sidebar title → Recent Chats |
| Debug logs | `Vertex Swarm: Open Debug Logs` |
| Sign out | Sidebar / `Sign Out` |

You can also talk to the **`@vertex-swarm`** chat participant in VS Code Chat.

### Agent tools

The worker loads tool categories as needed:

- `workspace_ops` — read / write / search workspace files  
- `terminal_ops` — run shell commands  
- `plan_tool` / `todo_tool` — plans and task lists  
- `web_search` — Exa (if key present)  
- `spawn_subagent` — nested agent tasks  
- `hil_tool` — human-in-the-loop prompts  

### Local data

```
~/.vertex-swarm/
├── chats/{chat_id}/     # meta.json, messages.jsonl, plan.md, session.json, logs/
├── nats-data-*/         # JetStream store (per port)
└── snapshots/           # undo snapshots
```

## Repo layout

```
vertex_swarm/
├── extension/           # VS Code extension + React webview
│   ├── src/             # process-manager, rpc-client, tools, auth, snapshots
│   ├── frontend/        # sidebar UI
│   └── bin/<platform>/  # nats-server + python-worker (packaged)
└── backend/             # Python worker (app.main_worker)
    ├── app/orchestrator.py
    ├── app/file_store.py
    ├── app/nats_client.py
    └── app/stdio_transport.py
hosted_auth_service/     # OAuth + entitlement API (Neon Postgres)
```

## Hosted auth (optional, for local auth server)

```bash
cd hosted_auth_service
python -m venv venv
# activate venv
pip install -r requirements.txt
# configure .env (DATABASE_URL, OAuth, JWT keys, …)
uvicorn app.main:app --reload --port 8080
```

Point the extension at it with `VERTEX_HOSTED_AUTH_URL=http://localhost:8080`.

## License

See `vertex_swarm/extension/LICENSE.txt`.
