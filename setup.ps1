[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('\A[a-p]{32}\z')]
    [string] $ExtensionId
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.push_to_codex.host'
$registration = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PushToCodex'
$manifestPath = Join-Path $installRoot "$hostName.json"
$project = Join-Path $PSScriptRoot 'native\PushHost.csproj'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'Install the .NET 10 SDK and run setup again.'
}
if ((Test-Path -LiteralPath $registration) -and
    (Get-Item -LiteralPath $registration).GetValue('') -ne $manifestPath) {
    throw 'This Chrome host name already points to a different installation.'
}
if ((Test-Path -LiteralPath $installRoot) -and
    ((Get-Item -LiteralPath $installRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "The installation directory is a junction or symbolic link: $installRoot"
}

# Keep older binaries available for Chrome processes already using them.
$versionPath = Join-Path $installRoot ('host-' + [Guid]::NewGuid().ToString('N'))
$publishPath = Join-Path $PSScriptRoot 'native\bin\setup-publish'
& dotnet publish $project -c Release --self-contained false -o $publishPath --nologo
if ($LASTEXITCODE -ne 0) { throw 'The Windows helper build failed.' }

New-Item -ItemType Directory -Path $versionPath -Force | Out-Null
foreach ($name in 'PushHost.exe', 'PushHost.dll', 'PushHost.deps.json', 'PushHost.runtimeconfig.json') {
    Copy-Item -LiteralPath (Join-Path $publishPath $name) -Destination $versionPath
}
$manifest = [ordered]@{
    name = $hostName
    description = 'Push from ChatGPT to Codex on Windows'
    path = Join-Path $versionPath 'PushHost.exe'
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $versionPath "$hostName.json"), $manifest)
$pendingManifest = Join-Path $installRoot ("$hostName." + [Guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($pendingManifest, $manifest)
if (Test-Path -LiteralPath $manifestPath) {
    [IO.File]::Replace($pendingManifest, $manifestPath, $null)
} else {
    [IO.File]::Move($pendingManifest, $manifestPath)
}

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Google\Chrome\NativeMessagingHosts\$hostName")
try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $key.Dispose() }

Write-Host "Push is registered for Chrome extension $ExtensionId. Refresh your ChatGPT tab."
