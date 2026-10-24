$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
docker compose exec -T app node server/cli.mjs @args
exit $LASTEXITCODE
