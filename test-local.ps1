$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is not installed or not available in PATH."
}

if (-not (Test-Path ".env.local")) {
    Copy-Item ".env.example" ".env.local"
    Write-Host "Created .env.local. Edit JWT_SECRET and INITIAL_PASSWORD, then run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "Building linux/amd64 rootless image..." -ForegroundColor Cyan
docker build --platform linux/amd64 -t 9router-blitz-rootless:test .
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

Write-Host "Starting container with blitz-like restrictions..." -ForegroundColor Cyan
docker rm -f 9router-blitz-test 2>$null | Out-Null

docker run --name 9router-blitz-test `
  --platform linux/amd64 `
  --user 1000:1000 `
  --cap-drop ALL `
  --security-opt no-new-privileges `
  -p 20128:20128 `
  --env-file .env.local `
  -v 9router-blitz-data:/app/data `
  9router-blitz-rootless:test
