$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    [Console]::Out.WriteLine('{"permissionDecision":"deny","permissionDecisionReason":"TokenReducer requires Node.js 20+. Restore Node, then use the bulk-reader skill or agent."}')
    exit 0
}
& node (Join-Path $PSScriptRoot 'read-gate.mjs')
exit $LASTEXITCODE
