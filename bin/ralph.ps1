#!/usr/bin/env pwsh
# Wrapper PowerShell: chama o CLI Node a partir de onde quer que o repo esteja.
$ErrorActionPreference = "Stop"
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) "src\cli.mjs"
& node $cli @args
exit $LASTEXITCODE
