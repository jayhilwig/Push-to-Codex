[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$hostName = 'com.push_to_codex.host'
$registration = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$localData = [IO.Path]::GetFullPath([Environment]::GetFolderPath('LocalApplicationData'))
$installRoot = Join-Path $localData 'PushToCodex'
$manifestPath = Join-Path $installRoot "$hostName.json"

if (Test-Path -LiteralPath $registration) {
    if ((Get-Item -LiteralPath $registration).GetValue('') -ne $manifestPath) {
        throw 'This Chrome host name points to a different installation.'
    }
    Remove-Item -LiteralPath $registration
}
if (Test-Path -LiteralPath $installRoot) {
    $resolvedRoot = (Get-Item -LiteralPath $installRoot)
    if ($resolvedRoot.FullName -ne $installRoot -or
        ($resolvedRoot.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected installation directory: $($resolvedRoot.FullName)"
    }

    foreach ($item in Get-ChildItem -LiteralPath $installRoot -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($item.PSIsContainer -and $item.Name -match '\Ahost-[a-f0-9]{32}\z' -and
            $item.Parent.FullName -eq $installRoot) {
            foreach ($file in 'PushHost.exe', 'PushHost.dll', 'PushHost.deps.json', 'PushHost.runtimeconfig.json', "$hostName.json") {
                $path = Join-Path $item.FullName $file
                if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
            }
            if (-not (Get-ChildItem -LiteralPath $item.FullName -Force)) { [IO.Directory]::Delete($item.FullName) }
        } elseif (-not $item.PSIsContainer -and ($item.Name -eq "$hostName.json" -or
            $item.Name -match '\Acom\.push_to_codex\.host\.[a-f0-9]{32}\.tmp\z')) {
            Remove-Item -LiteralPath $item.FullName
        }
    }
    if (-not (Get-ChildItem -LiteralPath $installRoot -Force)) { [IO.Directory]::Delete($installRoot) }
}
Write-Host 'Push helper removed. Remove the unpacked Push extension from chrome://extensions.'
