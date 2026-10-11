$ErrorActionPreference = 'Stop'

function Dump-Lines {
  param([string]$Path, [int]$From, [int]$To, [string]$Out)
  $lines = Get-Content -LiteralPath $Path
  ($lines[($From - 1)..($To - 1)] -join "`n") | Out-File -Encoding utf8 $Out
}

Dump-Lines 'tests\integration\schema.test.ts' 98 205 'sc1-tmp.txt'
Dump-Lines 'tests\integration\registrations.routes.test.ts' 100 300 'rt1-tmp.txt'

