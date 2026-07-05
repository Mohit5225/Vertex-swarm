# build_extension.ps1
# Script to compile the frontend and package the VS Code extension

$ErrorActionPreference = "Stop"

Write-Host "🚀 Starting Vertex Swarm Extension Build..." -ForegroundColor Cyan

# Step 1: Build Frontend
Write-Host "`n📦 Step 1: Building Frontend (React/Vite)..." -ForegroundColor Yellow
Set-Location -Path ".\extension\frontend"
npm install
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Frontend build failed!"
    exit 1
}

# Step 2: Build Extension
Write-Host "`n📦 Step 2: Packaging VS Code Extension..." -ForegroundColor Yellow
Set-Location -Path ".."
npm install
npm run package
if ($LASTEXITCODE -ne 0) {
    Write-Error "Extension packaging failed!"
    exit 1
}

Write-Host "`n✅ Build Complete! The .vsix file should be available in the extension directory." -ForegroundColor Green
