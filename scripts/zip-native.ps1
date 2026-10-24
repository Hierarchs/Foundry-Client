param([Parameter(Mandatory=$true)][string]$SourceDirectory,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Compress-Archive -Path (Join-Path $SourceDirectory '*') -DestinationPath $Destination -Force
