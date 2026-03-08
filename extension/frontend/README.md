# Vertex Swarm Frontend

Professional React UI for the Vertex Swarm VS Code extension.

## Setup

Install dependencies:

```bash
npm install
```

## Development

Start the dev server:

```bash
npm run dev
```

## Build

Build for production:

```bash
npm run build
```

Built files will be in `dist/` directory.

## Architecture

- **React 18** - UI framework
- **Zustand** - State management
- **Tailwind CSS v4** - Styling with custom VS Code theme colors
- **Vite** - Build tool

## Components

- `LoginPanel.tsx` - OAuth 2.0 authentication UI
- `ChatPanel.tsx` - Main chat interface
- `MessageRenderer.tsx` - Message and event rendering
- `InputArea.tsx` - Message input with auto-resize

## Store

- `authStore.ts` - Authentication state and extension bridge
- `chatStore.ts` - Chat messages and sessions

The VS Code extension communicates via `postMessage()` API defined in `webview-provider.ts`.
