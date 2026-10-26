<#
.SYNOPSIS
  Builds the web app and hosts it on S3 as a static website, then configures the
  data bucket (CORS, versioning) so the browser app can talk to it directly.

.EXAMPLE
  # Two buckets (recommended): one public site bucket, one private data bucket
  .\deploy\deploy.ps1 -SiteBucket my-team-collab-site -DataBucket my-team-files -Region eu-west-1

.EXAMPLE
  # Single bucket: site is served from the "_site/" prefix, data stays private
  .\deploy\deploy.ps1 -SiteBucket my-team-files -DataBucket my-team-files -Region eu-west-1

.EXAMPLE
  # Add a CloudFront/HTTPS origin to CORS and skip the npm build
  .\deploy\deploy.ps1 -SiteBucket s -DataBucket d -Region eu-west-1 -ExtraOrigins https://dxxxx.cloudfront.net -SkipBuild
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $SiteBucket,
  [Parameter(Mandatory)] [string] $DataBucket,
  [Parameter(Mandatory)] [string] $Region,
  [string] $Profile,
  [string[]] $ExtraOrigins = @(),
  [string] $Title = "S3 Office Collab",
  [switch] $SkipBuild,
  [switch] $NoVersioning
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$out  = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null

if ($Profile) { $env:AWS_PROFILE = $Profile }
$env:AWS_DEFAULT_REGION = $Region

function Invoke-Aws {
  param([Parameter(ValueFromRemainingArguments)] [string[]] $CliArgs)
  & aws @CliArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($CliArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

function Test-Bucket([string] $Name) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & aws s3api head-bucket --bucket $Name 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) }
  finally { $ErrorActionPreference = $prev }
}

function Ensure-Bucket([string] $Name) {
  if (Test-Bucket $Name) { Write-Host "Bucket $Name exists" -ForegroundColor DarkGray; return }
  Write-Host "Creating bucket $Name in $Region" -ForegroundColor Cyan
  if ($Region -eq "us-east-1") {
    Invoke-Aws s3api create-bucket --bucket $Name
  } else {
    Invoke-Aws s3api create-bucket --bucket $Name --create-bucket-configuration "LocationConstraint=$Region"
  }
}

# Regions whose website endpoint uses a dash (legacy) vs a dot.
$dashRegions = @("us-east-1","us-west-1","us-west-2","ap-southeast-1","ap-southeast-2","ap-northeast-1","eu-west-1","sa-east-1")
$sep = if ($dashRegions -contains $Region) { "-" } else { "." }
$websiteHost = "$SiteBucket.s3-website$sep$Region.amazonaws.com"
$sameBucket = ($SiteBucket -eq $DataBucket)
$sitePrefix = if ($sameBucket) { "_site/" } else { "" }
$siteUrl = "http://$websiteHost/$sitePrefix"

# ---------------------------------------------------------------- 1. Build
if (-not $SkipBuild) {
  Write-Host "Building web app..." -ForegroundColor Cyan
  Push-Location $root
  try {
    if (-not (Test-Path (Join-Path $root "node_modules"))) { npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $dist "index.html"))) { throw "dist/index.html not found. Run the build first." }

# Bake runtime config so users only need to type their keys.
$config = @{
  title          = $Title
  bucket         = $DataBucket
  region         = $Region
  lockBucket     = $true
  presignMinutes = 60
} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $dist "config.json"), $config, [Text.UTF8Encoding]::new($false))

# ---------------------------------------------------------------- 2. Site bucket
Ensure-Bucket $SiteBucket

Write-Host "Allowing public read on site objects..." -ForegroundColor Cyan
Invoke-Aws s3api put-public-access-block --bucket $SiteBucket --public-access-block-configuration `
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"

$policyResource = if ($sameBucket) { "arn:aws:s3:::$SiteBucket/$sitePrefix*" } else { "arn:aws:s3:::$SiteBucket/*" }
$policy = (Get-Content (Join-Path $PSScriptRoot "site-bucket-policy.json") -Raw) -replace "arn:aws:s3:::__SITE_BUCKET__/\*", $policyResource
$policyPath = Join-Path $out "site-bucket-policy.$SiteBucket.json"
[IO.File]::WriteAllText($policyPath, $policy, [Text.UTF8Encoding]::new($false))
Invoke-Aws s3api put-bucket-policy --bucket $SiteBucket --policy "file://$policyPath"

Write-Host "Enabling static website hosting..." -ForegroundColor Cyan
Invoke-Aws s3 website "s3://$SiteBucket" --index-document index.html --error-document index.html

Write-Host "Uploading site to s3://$SiteBucket/$sitePrefix ..." -ForegroundColor Cyan
Invoke-Aws s3 sync $dist "s3://$SiteBucket/$sitePrefix" --delete `
  --exclude "index.html" --exclude "config.json" --cache-control "public,max-age=31536000,immutable"
Invoke-Aws s3 cp (Join-Path $dist "index.html") "s3://$SiteBucket/${sitePrefix}index.html" `
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
Invoke-Aws s3 cp (Join-Path $dist "config.json") "s3://$SiteBucket/${sitePrefix}config.json" `
  --cache-control "no-cache" --content-type "application/json"

# ---------------------------------------------------------------- 3. Data bucket
Ensure-Bucket $DataBucket

if (-not $NoVersioning) {
  Write-Host "Enabling versioning on $DataBucket (recover overwritten files)..." -ForegroundColor Cyan
  Invoke-Aws s3api put-bucket-versioning --bucket $DataBucket --versioning-configuration Status=Enabled
}

$origins = @("http://$websiteHost", "http://$SiteBucket.s3-website-$Region.amazonaws.com", "http://$SiteBucket.s3-website.$Region.amazonaws.com", "http://localhost:5173") + $ExtraOrigins
$origins = $origins | Select-Object -Unique
$originsJson = ($origins | ForEach-Object { '"' + $_ + '"' }) -join ","
$cors = (Get-Content (Join-Path $PSScriptRoot "cors.json") -Raw) -replace '"__SITE_ORIGINS__"', $originsJson
$corsPath = Join-Path $out "cors.$DataBucket.json"
[IO.File]::WriteAllText($corsPath, $cors, [Text.UTF8Encoding]::new($false))
Write-Host "Applying CORS to $DataBucket ..." -ForegroundColor Cyan
Invoke-Aws s3api put-bucket-cors --bucket $DataBucket --cors-configuration "file://$corsPath"

# ---------------------------------------------------------------- 4. IAM policy for users
$iam = (Get-Content (Join-Path $PSScriptRoot "iam-user-policy.json") -Raw) -replace "__DATA_BUCKET__", $DataBucket
$iamPath = Join-Path $out "iam-user-policy.$DataBucket.json"
[IO.File]::WriteAllText($iamPath, $iam, [Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Site URL : $siteUrl"
Write-Host "  Data     : s3://$DataBucket ($Region)"
Write-Host ""
Write-Host "Next: give each user an IAM user/group with this policy, then create access keys for them:"
Write-Host "  $iamPath"
Write-Host "  e.g.  aws iam create-policy --policy-name ${DataBucket}-collab --policy-document file://$iamPath"
Write-Host ""
Write-Host "Tip: for HTTPS put CloudFront in front of the site bucket and re-run with -ExtraOrigins https://<your-domain>."
