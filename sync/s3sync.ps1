<#
.SYNOPSIS
  Sync a file or folder with an S3 bucket. Pure PowerShell 5.1 - no AWS CLI, no modules,
  no admin rights, works through the company proxy.

.DESCRIPTION
  Compares local files with S3 objects by content (MD5 vs ETag) and copies what differs.
    -Direction Up    local -> S3
    -Direction Down  S3 -> local
    -Direction Both  (default) newest version wins, never deletes, reports conflicts
  Office temp files (~$*.pptx) are skipped. Nothing is deleted unless you pass -Delete.

  Credentials, in order: -AccessKey/-SecretKey, env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY,
  saved profile (%APPDATA%\s3sync\<Profile>.xml, created with -SaveCredentials), or a prompt.

.EXAMPLE
  .\s3sync.ps1 -Path "C:\Projects\Acme" -Bucket my-team-files -Prefix "Projects/Acme/" -Region eu-west-1
.EXAMPLE
  .\s3sync.ps1 -Path "C:\Projects\Deck.pptx" -Bucket my-team-files -Prefix "Projects/Deck.pptx" -Region eu-west-1 -Direction Up
.EXAMPLE
  .\s3sync.ps1 -SaveCredentials            # store your keys once (DPAPI-encrypted for your Windows user)
.EXAMPLE
  .\s3sync.ps1 -Path C:\Projects -Bucket my-team-files -Region eu-west-1 -Direction Down -DryRun
#>
[CmdletBinding()]
param(
  [string] $Path,
  [string] $Bucket,
  [string] $Prefix = "",
  [string] $Region = "eu-west-1",
  [ValidateSet("Up", "Down", "Both")] [string] $Direction = "Both",
  [switch] $Delete,
  [switch] $DryRun,
  [ValidateSet("None", "Local", "Remote")] [string] $Prefer = "None",
  [string[]] $Exclude = @('~$*', '*.tmp', 'Thumbs.db', 'desktop.ini', '.DS_Store'),
  [string] $AccessKey,
  [string] $SecretKey,
  [string] $SessionToken,
  [string] $Profile = "default",
  [switch] $SaveCredentials,
  [string] $Endpoint,          # optional: S3-compatible endpoint, e.g. http://127.0.0.1:9000 (path-style)
  [switch] $NoProxy
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

# ============================================================ credentials
$credDir = Join-Path $env:APPDATA "s3sync"
$credFile = Join-Path $credDir "$Profile.xml"

if ($SaveCredentials) {
  $ak = Read-Host "Access key ID"
  $sk = Read-Host "Secret access key" -AsSecureString
  $st = Read-Host "Session token (leave empty unless using temporary credentials)"
  New-Item -ItemType Directory -Force -Path $credDir | Out-Null
  [pscustomobject]@{ AccessKey = $ak; Secret = ($sk | ConvertFrom-SecureString); Token = $st } | Export-Clixml -Path $credFile
  Write-Host "Saved to $credFile (encrypted for user $env:USERNAME on this machine)." -ForegroundColor Green
  if (-not $Path) { return }
}

if (-not $AccessKey) { $AccessKey = $env:AWS_ACCESS_KEY_ID; $SecretKey = $env:AWS_SECRET_ACCESS_KEY; $SessionToken = $env:AWS_SESSION_TOKEN }
if (-not $AccessKey -and (Test-Path $credFile)) {
  $c = Import-Clixml $credFile
  $AccessKey = $c.AccessKey
  $SecretKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR(($c.Secret | ConvertTo-SecureString)))
  $SessionToken = $c.Token
}
if (-not $AccessKey) {
  $AccessKey = Read-Host "Access key ID"
  $sk = Read-Host "Secret access key" -AsSecureString
  $SecretKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sk))
}
if (-not $Path -or -not $Bucket) { throw "Usage: s3sync.ps1 -Path <file|folder> -Bucket <bucket> [-Prefix <key or folder/>] [-Region eu-west-1] [-Direction Up|Down|Both]" }

# ============================================================ HTTP + SigV4
$pathStyle = [bool]$Endpoint -or $Bucket.Contains(".")
if ($Endpoint) { $baseUri = [Uri]$Endpoint.TrimEnd("/") } else { $baseUri = [Uri]("https://" + $(if ($pathStyle) { "s3.$Region.amazonaws.com" } else { "$Bucket.s3.$Region.amazonaws.com" })) }
$hostHeader = $baseUri.Host + $(if ($baseUri.IsDefaultPort) { "" } else { ":" + $baseUri.Port })

$handler = New-Object System.Net.Http.HttpClientHandler
if ($NoProxy) { $handler.UseProxy = $false } else {
  $handler.UseProxy = $true
  $handler.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
  $handler.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
}
$Http = New-Object System.Net.Http.HttpClient($handler)
$Http.Timeout = [TimeSpan]::FromHours(2)

$sha256 = [System.Security.Cryptography.SHA256]::Create()
function Hex([byte[]] $b) { ($b | ForEach-Object { $_.ToString("x2") }) -join "" }
function Sha256Hex([string] $s) { Hex ($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))) }
function HmacSha256([byte[]] $key, [string] $data) { $h = New-Object System.Security.Cryptography.HMACSHA256; $h.Key = $key; $h.ComputeHash([Text.Encoding]::UTF8.GetBytes($data)) }
function UriEncode([string] $s, [bool] $keepSlash) {
  $sb = New-Object Text.StringBuilder
  foreach ($b in [Text.Encoding]::UTF8.GetBytes($s)) {
    $c = [char]$b
    if (($c -ge 'A' -and $c -le 'Z') -or ($c -ge 'a' -and $c -le 'z') -or ($c -ge '0' -and $c -le '9') -or $c -eq '-' -or $c -eq '_' -or $c -eq '.' -or $c -eq '~' -or ($keepSlash -and $c -eq '/')) { [void]$sb.Append($c) }
    else { [void]$sb.AppendFormat("%{0:X2}", $b) }
  }
  $sb.ToString()
}
$EmptyHash = Sha256Hex ""

function Invoke-S3 {
  param([string] $Method, [string] $Key = "", [hashtable] $Query = @{}, [string] $InFile, [string] $OutFile, [hashtable] $Meta = @{}, [string] $ContentType, [string] $ContentMd5, [switch] $AllowNotFound)
  $uriPath = "/" + $(if ($pathStyle) { (UriEncode $Bucket $false) + "/" } else { "" }) + (UriEncode $Key $true)
  $canonQuery = (($Query.Keys | Sort-Object) | ForEach-Object { (UriEncode $_ $false) + "=" + (UriEncode ([string]$Query[$_]) $false) }) -join "&"
  $amzDate = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ"); $dateStamp = $amzDate.Substring(0, 8)
  $payloadHash = if ($InFile) { "UNSIGNED-PAYLOAD" } else { $EmptyHash }
  $headers = [ordered]@{ "host" = $hostHeader; "x-amz-content-sha256" = $payloadHash; "x-amz-date" = $amzDate }
  if ($SessionToken) { $headers["x-amz-security-token"] = $SessionToken }
  foreach ($k in $Meta.Keys) { $headers["x-amz-meta-$k"] = [string]$Meta[$k] }
  $sorted = $headers.Keys | Sort-Object
  $canonHeaders = ($sorted | ForEach-Object { "$($_):$($headers[$_].Trim())`n" }) -join ""
  $signedHeaders = $sorted -join ";"
  $canonical = "$Method`n$uriPath`n$canonQuery`n$canonHeaders`n$signedHeaders`n$payloadHash"
  $scope = "$dateStamp/$Region/s3/aws4_request"
  $sts = "AWS4-HMAC-SHA256`n$amzDate`n$scope`n$(Sha256Hex $canonical)"
  $kDate = HmacSha256 ([Text.Encoding]::UTF8.GetBytes("AWS4$SecretKey")) $dateStamp
  $kRegion = HmacSha256 $kDate $Region; $kService = HmacSha256 $kRegion "s3"; $kSigning = HmacSha256 $kService "aws4_request"
  $signature = Hex (HmacSha256 $kSigning $sts)
  $auth = "AWS4-HMAC-SHA256 Credential=$AccessKey/$scope, SignedHeaders=$signedHeaders, Signature=$signature"

  $url = $baseUri.Scheme + "://" + $hostHeader + $uriPath + $(if ($canonQuery) { "?$canonQuery" } else { "" })
  $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method)), $url)
  foreach ($k in $headers.Keys) { if ($k -ne "host") { [void]$req.Headers.TryAddWithoutValidation($k, $headers[$k]) } }
  $req.Headers.Host = $hostHeader
  [void]$req.Headers.TryAddWithoutValidation("Authorization", $auth)
  $fs = $null
  if ($InFile) {
    $fs = [IO.File]::OpenRead($InFile)
    $req.Content = New-Object System.Net.Http.StreamContent($fs)
    $req.Content.Headers.ContentLength = $fs.Length
    if ($ContentType) { $req.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType) }
    if ($ContentMd5) { [void]$req.Content.Headers.TryAddWithoutValidation("Content-MD5", $ContentMd5) }
  }
  try {
    $resp = $Http.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $status = [int]$resp.StatusCode
    if ($status -eq 404 -and $AllowNotFound) { return $null }
    if ($status -ge 300) {
      $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $code = if ($body -match "<Code>([^<]+)</Code>") { $Matches[1] } else { "" }
      $msg = if ($body -match "<Message>([^<]+)</Message>") { $Matches[1] } else { $body }
      throw "S3 $Method $Key failed: HTTP $status $code $msg"
    }
    if ($OutFile) {
      $dir = Split-Path $OutFile -Parent; if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      $tmp = "$OutFile.s3sync.part"
      $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $out = [IO.File]::Create($tmp)
      try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
      Move-Item -Force $tmp $OutFile
      $body = $null
    } elseif ($Method -eq "HEAD") { $body = $null } else { $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
    $h = @{}
    foreach ($hd in $resp.Headers) { $h[$hd.Key.ToLower()] = ($hd.Value -join ",") }
    foreach ($hd in $resp.Content.Headers) { $h[$hd.Key.ToLower()] = ($hd.Value -join ",") }
    return [pscustomobject]@{ Status = $status; Headers = $h; Body = $body }
  } finally { if ($fs) { $fs.Dispose() }; $req.Dispose() }
}

# ============================================================ S3 helpers
function Get-RemoteIndex([string] $KeyPrefix) {
  $index = @{}
  $token = $null
  do {
    $q = @{ "list-type" = "2"; "prefix" = $KeyPrefix }
    if ($token) { $q["continuation-token"] = $token }
    $r = Invoke-S3 -Method GET -Query $q
    [xml]$xml = $r.Body
    $ns = @{ s = $xml.DocumentElement.NamespaceURI }
    foreach ($c in (Select-Xml -Xml $xml -XPath "//s:Contents" -Namespace $ns)) {
      $n = $c.Node
      if ($n.Key.EndsWith("/")) { continue }
      $rel = $n.Key.Substring($KeyPrefix.Length)
      if ($rel.StartsWith(".locks/")) { continue }
      $index[$rel] = [pscustomobject]@{ Key = $n.Key; Size = [long]$n.Size; ETag = $n.ETag.Trim('"'); LastModified = [DateTime]::Parse($n.LastModified).ToUniversalTime() }
    }
    $truncated = (Select-Xml -Xml $xml -XPath "//s:IsTruncated" -Namespace $ns).Node.InnerText -eq "true"
    $token = if ($truncated) { (Select-Xml -Xml $xml -XPath "//s:NextContinuationToken" -Namespace $ns).Node.InnerText } else { $null }
  } while ($token)
  return $index
}

function Get-RemoteMtime($remote) {
  $h = Invoke-S3 -Method HEAD -Key $remote.Key
  if ($h.Headers["x-amz-meta-mtime"]) { return [DateTimeOffset]::FromUnixTimeSeconds([long]$h.Headers["x-amz-meta-mtime"]).UtcDateTime }
  return $remote.LastModified
}

$md5 = [System.Security.Cryptography.MD5]::Create()
function Get-FileMd5([string] $file) { $s = [IO.File]::OpenRead($file); try { $md5.ComputeHash($s) } finally { $s.Dispose() } }
function Get-ContentType([string] $name) {
  switch -Regex ($name.ToLower()) {
    '\.pptx$' { "application/vnd.openxmlformats-officedocument.presentationml.presentation" }
    '\.xlsx$' { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    '\.docx$' { "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
    '\.pdf$'  { "application/pdf" }
    '\.csv$'  { "text/csv" }
    '\.txt$'  { "text/plain" }
    default   { "application/octet-stream" }
  }
}
function Upload($localFile, [string] $key) {
  $mtime = [DateTimeOffset]::new($localFile.LastWriteTimeUtc).ToUnixTimeSeconds()
  $b64 = [Convert]::ToBase64String($localFile.Md5Bytes)
  Invoke-S3 -Method PUT -Key $key -InFile $localFile.FullName -ContentType (Get-ContentType $localFile.Name) -ContentMd5 $b64 -Meta @{ mtime = $mtime; "modified-by" = $env:USERNAME } | Out-Null
}
function Download($remote, [string] $dest) {
  Invoke-S3 -Method GET -Key $remote.Key -OutFile $dest | Out-Null
  $m = Get-RemoteMtime $remote
  (Get-Item $dest).LastWriteTimeUtc = $m
}

# ============================================================ local index
$Path = (Resolve-Path $Path -ErrorAction SilentlyContinue).Path
if (-not $Path) { $Path = $PSBoundParameters["Path"] }  # may not exist yet when pulling
$isFile = Test-Path $Path -PathType Leaf
$local = @{}
if ($isFile) {
  $f = Get-Item $Path
  $md5b = Get-FileMd5 $f.FullName
  $local[$f.Name] = [pscustomobject]@{ FullName = $f.FullName; Name = $f.Name; Size = $f.Length; Md5Bytes = $md5b; Md5 = Hex $md5b; LastWriteTimeUtc = $f.LastWriteTimeUtc }
  if (-not $Prefix -or $Prefix.EndsWith("/")) { $Prefix = $Prefix + $f.Name }
  $keyPrefix = $Prefix.Substring(0, $Prefix.Length - $f.Name.Length)  # folder part
  if ($Prefix.Split("/")[-1] -ne $f.Name) {                          # custom key name
    $keyPrefix = ""; $local = @{}; $local[$Prefix] = [pscustomobject]@{ FullName = $f.FullName; Name = $f.Name; Size = $f.Length; Md5Bytes = $md5b; Md5 = Hex $md5b; LastWriteTimeUtc = $f.LastWriteTimeUtc }
  }
  $localRoot = $f.DirectoryName
} else {
  if ($Prefix -and -not $Prefix.EndsWith("/")) { $Prefix += "/" }
  $keyPrefix = $Prefix
  $localRoot = $Path
  if (Test-Path $Path) {
    foreach ($f in Get-ChildItem -Path $Path -Recurse -File -Force) {
      $skip = $false; foreach ($pat in $Exclude) { if ($f.Name -like $pat) { $skip = $true; break } }
      if ($skip -or $f.Name.EndsWith(".s3sync.part")) { continue }
      $rel = $f.FullName.Substring($localRoot.TrimEnd('\').Length + 1).Replace("\", "/")
      $md5b = Get-FileMd5 $f.FullName
      $local[$rel] = [pscustomobject]@{ FullName = $f.FullName; Name = $f.Name; Size = $f.Length; Md5Bytes = $md5b; Md5 = Hex $md5b; LastWriteTimeUtc = $f.LastWriteTimeUtc }
    }
  } elseif ($Direction -eq "Up") { throw "Local path not found: $Path" }
}

# ============================================================ remote index
Write-Host "Local : $Path ($($local.Count) file(s))" -ForegroundColor DarkGray
Write-Host "Remote: s3://$Bucket/$Prefix  [$Region]  direction=$Direction$(if ($DryRun) { '  DRY RUN' })" -ForegroundColor DarkGray
if ($isFile) {
  $remote = @{}
  foreach ($rel in $local.Keys) {
    $key = if ($keyPrefix -eq "" -and $rel -eq $Prefix) { $Prefix } else { $keyPrefix + $rel }
    $h = Invoke-S3 -Method HEAD -Key $key -AllowNotFound
    if ($h) { $remote[$rel] = [pscustomobject]@{ Key = $key; Size = [long]$h.Headers["content-length"]; ETag = $h.Headers["etag"].Trim('"'); LastModified = [DateTime]::Parse($h.Headers["last-modified"]).ToUniversalTime() } }
  }
} else {
  $remote = Get-RemoteIndex $keyPrefix
  foreach ($rel in @($remote.Keys)) { $skip = $false; foreach ($pat in $Exclude) { if ((Split-Path $rel -Leaf) -like $pat) { $skip = $true; break } }; if ($skip) { $remote.Remove($rel) } }
}

# ============================================================ plan + execute
$stats = @{ up = 0; down = 0; same = 0; skip = 0; conflict = 0; del = 0; err = 0 }
function Act([string] $what, [string] $rel, [scriptblock] $do) {
  $color = switch ($what) { "UPLOAD" { "Cyan" } "DOWNLOAD" { "Green" } "CONFLICT" { "Yellow" } "DELETE-LOCAL" { "Red" } "DELETE-REMOTE" { "Red" } default { "Gray" } }
  Write-Host ("{0,-14} {1}" -f $what, $rel) -ForegroundColor $color
  if ($DryRun -or -not $do) { return }
  try { & $do } catch { $stats.err++; Write-Host "   ERROR: $($_.Exception.Message)" -ForegroundColor Red }
}

$all = @($local.Keys) + @($remote.Keys) | Sort-Object -Unique
foreach ($rel in $all) {
  $L = $local[$rel]; $R = $remote[$rel]
  $key = if ($R) { $R.Key } elseif ($keyPrefix -eq "" -and $isFile) { $Prefix } else { $keyPrefix + $rel }
  $dest = if ($L) { $L.FullName } else { Join-Path $localRoot ($rel.Replace("/", "\")) }

  if ($L -and -not $R) {
    if ($Direction -ne "Down") { $stats.up++; Act "UPLOAD" $rel { Upload $L $key } }
    elseif ($Delete) { $stats.del++; Act "DELETE-LOCAL" $rel { Remove-Item -Force $L.FullName } }
    else { $stats.skip++; Act "only-local" $rel $null }
    continue
  }
  if ($R -and -not $L) {
    if ($Direction -ne "Up") { $stats.down++; Act "DOWNLOAD" $rel { Download $R $dest } }
    elseif ($Delete) { $stats.del++; Act "DELETE-REMOTE" $rel { Invoke-S3 -Method DELETE -Key $R.Key | Out-Null } }
    else { $stats.skip++; Act "only-remote" $rel $null }
    continue
  }
  if ($R.ETag -eq $L.Md5) { $stats.same++; continue }

  switch ($Direction) {
    "Up"   { $stats.up++;   Act "UPLOAD" $rel { Upload $L $key } }
    "Down" { $stats.down++; Act "DOWNLOAD" $rel { Download $R $dest } }
    "Both" {
      $rm = Get-RemoteMtime $R
      $lm = $L.LastWriteTimeUtc
      $diff = ($lm - $rm).TotalSeconds
      if ($Prefer -eq "Local" -or $diff -gt 2)       { $stats.up++;   Act "UPLOAD" "$rel  (local newer by $([math]::Round([math]::Abs($diff)))s)" { Upload $L $key } }
      elseif ($Prefer -eq "Remote" -or $diff -lt -2) { $stats.down++; Act "DOWNLOAD" "$rel  (remote newer by $([math]::Round([math]::Abs($diff)))s)" { Download $R $dest } }
      else { $stats.conflict++; Act "CONFLICT" "$rel  (same time, different content - use -Prefer Local|Remote)" $null }
    }
  }
}

Write-Host ""
Write-Host ("Done: {0} uploaded, {1} downloaded, {2} unchanged, {3} skipped, {4} conflicts, {5} deleted, {6} errors" -f $stats.up, $stats.down, $stats.same, $stats.skip, $stats.conflict, $stats.del, $stats.err) -ForegroundColor $(if ($stats.err -or $stats.conflict) { "Yellow" } else { "Green" })
if ($stats.err) { exit 1 }
