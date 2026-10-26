# S3 Office Collab

A **100% static web app** (plain HTML/JS, hosted in an S3 bucket) that lets a team
share PowerPoint and Excel files stored in S3. Nothing to install on user machines —
it runs in any modern browser (Edge, Chrome, Firefox).

- Sign in with an **AWS access key + secret key** (and optional session token)
- Browse folders, **upload** (drag & drop), download, rename, delete
- **PowerPoint (.pptx)**: slide-by-slide preview in the browser
- **Excel (.xlsx/.xlsm/.xls/.csv)**: sheet viewer with quick cell editing and save back to S3
- **Open in PowerPoint / Excel**: launches the desktop Office app directly on the S3 file
- **Check-out / check-in locks** so two people don't overwrite each other, plus
  "someone saved a newer version" detection on save
- Keys never leave the browser: all calls go straight from the browser to S3 over HTTPS.
  Keys are held in `sessionStorage` only (cleared when the tab closes).

## Editing: what works where

| Need | What this app does |
| --- | --- |
| View slides in the browser | ✅ Built-in `.pptx` renderer (approximation of layout; no animations) |
| **Edit in PowerPoint/Excel and Save straight to S3** | ✅ With the **Lambda WebDAV gateway** (see below): "Edit in PowerPoint" opens the S3 file in desktop Office; Ctrl+S writes back to the bucket (files ≤ 6 MB) |
| Edit Excel cells in the browser | ✅ Quick edits of values/formulas. Rich formatting, charts, pivots may be lost on save — for heavy edits use **Edit in Excel** |
| Edit slides *inside the browser tab* | ❌ Needs Microsoft 365 (WOPI) or a self-hosted ONLYOFFICE/Collabora server; not included |

Without the gateway the app is 100% static and "Open in PowerPoint" opens a read-only copy;
you then use **Upload new version**.

## WebDAV gateway on Lambda (save directly from Office to S3)

S3 does not speak WebDAV, which is what desktop Office needs to save back to a URL. The
gateway is a single **AWS Lambda function** (`gateway/index.mjs`, Node.js, no dependencies
beyond the SDK bundled in the runtime) behind a **Function URL**:

- Translates WebDAV (`PROPFIND`, `GET`, `PUT`, `LOCK`, `MOVE`, …) to S3 calls. Basic-auth
  **username = access key ID, password = secret access key**; every S3 call is signed as that
  user, so the function has **no S3 permissions** and stores no secrets; CloudTrail shows who saved.
- Office's `LOCK/UNLOCK` are honoured (locks live in `.locks/<file>.dav.json` in the bucket),
  so PowerPoint opens files read/write and other Office users get the usual "locked by …" notice.
- Free HTTPS on `https://<id>.lambda-url.<region>.on.aws` — no domain, no servers, ~US$0 idle.

**Limits (Lambda Function URLs):** a request body is capped at **6 MB**, so Office cannot
save files larger than ~6 MB through the gateway — the web app warns and offers a read-only
copy instead (`maxEditBytes` in `config.json`). Streamed downloads are capped at 20 MB.
AWS documents only the standard HTTP methods for Function URLs; the deploy script self-tests
`PROPFIND`/`LOCK`/`MKCOL`/`MOVE` against the live URL and reports if any are rejected.

```powershell
# 1. Gateway (Lambda + Function URL; prints the URL and the self-test)
.\deploy\deploy-gateway.ps1 -Bucket my-team-files -Region eu-west-1

# 2. Site, with the gateway URL baked into config.json
.\deploy\deploy.ps1 -SiteBucket my-team-files-site -DataBucket my-team-files -Region eu-west-1 -WebDavUrl https://<id>.lambda-url.eu-west-1.on.aws
```

Users: click **Edit in PowerPoint** → PowerPoint asks once for a login (access key ID /
secret key, tick *Remember*) → edit → **Save**. The app also takes the soft check-out lock so the
file list shows who is editing; click **Check in** when done.

Operations: `aws logs tail /aws/lambda/<function> --follow`; re-run `deploy-gateway.ps1`
to update; `-Delete` removes it; `-Buffered` switches the Function URL to buffered responses
if Office has trouble with streamed downloads.

Local testing without AWS: `gateway/local-server.mjs` runs the same handler as an HTTP server
(see its header comment); this is how the Office round-trip was verified.

## Project layout

```
src/
  aws/s3.ts              S3 client wrapper (list/get/put/delete/copy, presigned URLs, locks)
  components/Login.tsx   Access key / secret key form
  components/FileBrowser.tsx
  components/Viewer.tsx  Full-screen file view: download, Open in Office, Upload new version
  components/PptxViewer.tsx
  components/XlsxEditor.tsx
public/config.json       Runtime config (bucket, region, title, webdavUrl) – written by deploy.ps1
gateway/
  index.mjs              Lambda handler: WebDAV -> S3 (Basic auth = user's own AWS keys)
  local-server.mjs       Runs the handler as a local HTTP server for testing
deploy/
  deploy.ps1             Build + create/configure buckets + upload site
  deploy-gateway.ps1     Create/update/delete the Lambda gateway + Function URL (with self-test)
  cors.json              CORS template applied to the data bucket
  site-bucket-policy.json
  iam-user-policy.json   Least-privilege policy for end users
```

## Prerequisites (deployer only)

- Node.js 18+ and npm
- AWS CLI configured with admin-ish rights on S3 (`aws configure`)

End users need nothing but a browser and their own access key.

## Build & deploy

```powershell
npm install

# Recommended: separate site bucket (public read) and data bucket (private)
.\deploy\deploy.ps1 -SiteBucket my-team-collab-site -DataBucket my-team-files -Region eu-west-1

# Or a single bucket (the site lives under the "_site/" prefix, data stays private)
.\deploy\deploy.ps1 -SiteBucket my-team-files -DataBucket my-team-files -Region eu-west-1
```

The script:

1. runs `npm run build` and writes `config.json` (bucket/region pre-filled and locked),
2. creates the site bucket if needed, enables static website hosting, applies a
   public-read bucket policy **only** for the site files, uploads `dist/`,
3. creates the data bucket if needed, enables versioning (undo overwrites), applies CORS
   allowing the website origin,
4. writes `deploy/out/iam-user-policy.<bucket>.json` for your users,
5. prints the site URL (`http://<site-bucket>.s3-website-<region>.amazonaws.com/`).

Options: `-Profile <aws profile>`, `-ExtraOrigins https://files.example.com`,
`-Title "Team Files"`, `-SkipBuild`, `-NoVersioning`.

### Give users access

```powershell
aws iam create-policy --policy-name my-team-files-collab --policy-document file://deploy/out/iam-user-policy.my-team-files.json
aws iam create-group --group-name team-files
aws iam attach-group-policy --group-name team-files --policy-arn arn:aws:iam::<account-id>:policy/my-team-files-collab
aws iam create-user --user-name jane
aws iam add-user-to-group --user-name jane --group-name team-files
aws iam create-access-key --user-name jane      # give Jane the AccessKeyId + SecretAccessKey
```

Each person signs in with their own key, so S3 server-access logs / CloudTrail show who did what,
and the "modified-by" metadata on every uploaded object records the display name.

### HTTPS (recommended for production)

S3 website endpoints are HTTP only. For HTTPS put **CloudFront** in front of the site
bucket (origin = the website endpoint), then re-run the deploy with
`-ExtraOrigins https://<cloudfront-domain>` so the data bucket's CORS allows it.
The app itself works on either.

### Company proxies / locked machines

The browser needs outbound HTTPS to `*.s3.<region>.amazonaws.com` (direct S3 API calls)
and HTTP(S) to the site URL. No installs, no extensions, no admin rights.
"Open in PowerPoint/Excel" uses the `ms-powerpoint:` / `ms-excel:` URL schemes that
Office installs by default; if Office is absent, use Download instead.

## Local development

```powershell
npm run dev        # http://localhost:5173
```

The deploy script adds `http://localhost:5173` to the data bucket's CORS so you can
test against the real bucket locally. Edit `public/config.json` to pre-fill bucket/region.

## How collaboration works

- **Check out** a file before editing: writes `.locks/<key>.lock.json` with your name and time.
  Others see 🔒 and who holds it. They can force-unlock if needed.
- **Open in PowerPoint/Excel** opens the file from a 2-hour presigned URL in the desktop
  app. Save locally, then **Upload new version** in the viewer (it warns if someone else
  uploaded in between) and check the file back in.
- Versioning on the data bucket keeps every overwritten version recoverable from the
  AWS console (`aws s3api list-object-versions`).

## Third-party licences

- `pptx-preview` (PowerPoint rendering): free for personal and commercial use per its
  README; the library itself is not open source.
- SheetJS Community Edition (`xlsx`, Apache-2.0) – installed from the SheetJS CDN
  because the npm registry copy is outdated.
- AWS SDK for JavaScript v3 (Apache-2.0), React (MIT), Vite (MIT).
