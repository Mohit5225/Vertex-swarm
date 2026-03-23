# Extension Host (Vertex Swarm)

VS Code Extension Host runtime - handles OAuth, token management, and SSE streaming relay.

## Architecture

```
Extension Host (Node.js/TypeScript)
├── token-manager.ts       # SecretStorage integration (OS keychain)
├── oauth-handler.ts       # Neon Auth OAuth 2.0 flow
├── sse-client/stream.ts   # EventSource → postMessage relay
└── extension.ts           # Main entry point + webview creation
```

## Data Flow

1. **Authentication:**
   - Webview requests token → Extension opens browser OAuth flow
   - OAuth callback → token exchange → stored in SecretStorage
   - Token sent to Webview via postMessage

2. **Streaming:**
   - Webview sends `start-stream` message
   - Extension opens SSE connection to Backend `/api/v1/chats/{chatId}/messages`
   - Events parsed and relayed to Webview via postMessage
   - Webview updates Zustand store → React re-renders

3. **Cancellation:**
   - Webview sends `cancel-stream` message
   - Extension sends POST to Backend `/api/v1/chats/{chatId}/cancel`
   - Stream closes

## Key Files

- **token-manager.ts** - Handles secure token storage using VS Code SecretStorage (OS keychain)
- **oauth-handler.ts** - Opens browser, listens for callback, exchanges code for JWT
- **sse-client/stream.ts** - Opens EventSource connection, parses events, relays via postMessage
- **extension.ts** - Webview panel creation, message routing, lifecycle management

## Security Model

- **Token Storage:** OS keychain via SecretStorage (NOT in Webview)
- **Relay Pattern:** Extension Host holds token, never sends to Webview
- **Webview:** React UI only receives events/data, no sensitive credentials

## Build

```bash
npm install
npm run build
```

## Development

```bash
npm run dev
```

In VS Code, use the `Run Vertex Swarm Extension` debug configuration from `.vscode/launch.json`.
It starts the extension host once and watches both the extension bundle and the frontend bundle in the background.
