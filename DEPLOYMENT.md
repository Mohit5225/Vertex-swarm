# Vertex Swarm Deployment Guide

## 1. Backend Deployment (Docker)

The backend is a Python FastAPI server that requires PostgreSQL and Redis. It can be containerized using the provided `Dockerfile`.

### Prerequisites
- Docker & Docker Compose (or a cloud provider like Render, Fly.io, AWS)
- A Neon.tech account for PostgreSQL
- A Redis instance (managed or local)
- An OpenRouter API Key

### Building the Image
From the `vertex_swarm/backend` directory:
```bash
docker build -t vertex-swarm-backend .
```

### Running the Container
Make sure to provide your environment variables. You can pass an env file or provide them directly:
```bash
docker run -p 8000:8000 --env-file .env vertex-swarm-backend
```

*Note: For production, ensure `DEBUG=False` and set strong secrets for authentication.*

---

## 2. Frontend & VS Code Extension Deployment

The frontend (React) is bundled into the VS Code extension (`.vsix`) before publication. 

### Prerequisites
- Node.js (v18+)
- VSCE (`npm install -g @vscode/vsce`)
- A Visual Studio Marketplace Publisher ID and Personal Access Token (PAT).

### Building the Extension
We have provided a convenience script to build the frontend and package the extension. From the `vertex_swarm` directory:
```powershell
.\build_extension.ps1
```
This will generate a `vertex-swarm-extension-X.Y.Z.vsix` file in the `extension/` folder.

### Publishing to the Marketplace
Once the `.vsix` is generated, ensure your `package.json` has the correct `publisher`, `repository`, and `license` configured.

Publish the extension using VSCE:
```bash
cd extension
vsce publish
```
*You will be prompted for your Personal Access Token (PAT) the first time you run this command.*

Alternatively, you can manually upload the generated `.vsix` file through the [Marketplace Publisher Management Portal](https://marketplace.visualstudio.com/manage).
