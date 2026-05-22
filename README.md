# Gofile Link Saver API for Cloudflare Pages

This repository configures a serverless API and an accompanying dashboard hosted on Cloudflare Pages. It allows you to trigger micro-downloads on Gofile folders, resetting Gofile's 30-day inactivity timer without consuming significant network bandwidth on either side.

---

## Directory Structure

```text
gofile-keepalive/
├── public/
│   └── index.html          # Static admin dashboard
├── functions/
│   └── api/
│       └── keep-alive.ts   # Serverless keep-alive endpoint
├── package.json            # Development dependencies
└── README.md               # Documentation
```

---

## How It Works

Gofile automatically deletes hosted files if they do not receive download traffic within a 30-day period. 

To keep links active without downloading entire video or archive files, this API uses the HTTP `Range: bytes=0-0` header. When sent to Gofile's download endpoints, this header requests only the first byte of the file. This registers as a successful download event on Gofile's servers, updating the file's last-downloaded timestamp while consuming virtually zero bandwidth.

---

## API Specifications

### Keep-Alive Handler

- **URL**: `/api/keep-alive`
- **Method**: `POST`
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <API_ACCESS_TOKEN>` *(Only verified if `API_ACCESS_TOKEN` is configured in the Cloudflare dashboard)*

#### Request Payload
```json
{
  "url": "https://gofile.io/d/AbC123"
}
```

#### Response Example (Status 200)
```json
{
  "status": "success",
  "data": {
    "folderId": "AbC123",
    "filesProcessed": [
      {
        "id": "abcde-1234-5678-abcd",
        "name": "episode-01.mp4",
        "success": true,
        "status": 206
      }
    ]
  }
}
```

#### Error Response Example (Status 401)
```json
{
  "error": "Unauthorized Access"
}
```

---

## Local Development Setup

To run and test the application on your local machine:

1. Install local project tools:
   ```bash
   npm install
   ```
2. Start the Cloudflare Pages local emulator (Wrangler):
   ```bash
   npm run dev
   ```
3. Open `http://localhost:8788` in your web browser to access the test interface.

---

## Deploying to Cloudflare Pages

### Step 1: Initialize Git and Commit Files
Initialize a local git repository, stage your files, and commit them:
```bash
git init
git add .
git commit -m "Initial Gofile Keep-Alive setup"
```
Create a repository on GitHub (or GitLab/Bitbucket) and push your local commits to the remote repository.

### Step 2: Configure Cloudflare Pages
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Navigate to **Workers & Pages** > **Pages** > **Connect to Git**.
3. Select your repository.
4. Set up the Build settings:
   - **Framework preset**: None
   - **Build command**: *Leave empty*
   - **Build output directory**: `public`
5. Click **Save and Deploy**.

### Step 3: Add Environment Variables (Optional but Recommended)
If you want to secure your API endpoint from unauthorized public requests:
1. Inside your Pages Project on the Cloudflare dashboard, go to **Settings** > **Variables**.
2. Click **Add Variable** under *Environment Variables*.
3. Add the following entry:
   - **Variable name**: `API_ACCESS_TOKEN`
   - **Value**: *Your custom secure API password*
4. Click **Save**.
5. Redeploy your site for the environment variables to take effect.

---

## Integration with an External Site (e.g., Anime Streaming CMS)

To automate the link saving process, program your website's backend server to track your Gofile links in a database, query links that are older than 15-20 days, and dispatch periodic requests to your deployed Pages API.

### Example Integration (PHP Curl)
```php
<?php
$gofile_url = "https://gofile.io/d/AbC123";
$api_endpoint = "https://your-pages-subdomain.pages.dev/api/keep-alive";
$access_token = "your_secure_api_access_token";

$ch = curl_init($api_endpoint);

$payload = json_encode(array("url" => $gofile_url));

curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_HTTPHEADER, array(
    'Content-Type: application/json',
    'Authorization: Bearer ' . $access_token
));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);

$response = curl_exec($ch);
curl_close($ch);

$result = json_decode($response, true);
if (isset($result['status']) && $result['status'] === 'success') {
    // Successfully pinged. Update last_pinged_at timestamp in your database
}
?>
```
