# Multi-Service Link Saver API

A production-grade, serverless keep-alive API deployed to Cloudflare Pages. It automatically triggers 1-byte partial HTTP downloads (`Range: bytes=0-0`) to reset the 30-day inactivity deletion countdown on files hosted on **Gofile**, **Pixeldrain**, and **Krakenfiles**.

---

## Directory Structure

```text
gofile-keepalive/
├── public/
│   └── index.html          # Control panel interface
├── functions/
│   └── api/
│       └── keep-alive/
│           ├── gofile.ts       # Serverless function for Gofile
│           ├── pixeldrain.ts   # Serverless function for Pixeldrain
│           └── krakenfiles.ts  # Serverless function for Krakenfiles
├── package.json            # Deployment dependencies
├── tsconfig.json           # Cloudflare compilation schema
└── README.md               # Documentation
```

---

## Deployment & Setup

### 1. Upload to GitHub / GitLab
Push your project files to a private repository on your hosting control account.

### 2. Configure Cloudflare Pages
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Go to **Workers & Pages** > **Create** > **Pages** and select your repository.
3. Configure your Build settings:
   - **Framework preset**: None
   - **Build command**: *Leave empty*
   - **Build output directory**: `public`
4. Click **Save and Deploy**.

### 3. Add Optional Security (API Protection)
To lock the endpoints and restrict public abuse, configure a bearer token:
1. Go to **Settings** > **Variables** in your Pages project dashboard.
2. Under *Environment Variables*, click **Add variable**:
   - **Variable name**: `API_ACCESS_TOKEN`
   - **Value**: *Your custom secure secret phrase*
3. Save the variable and redeploy your project. When active, all incoming POST requests must carry the following header:
   `Authorization: Bearer YourCustomSecureSecretPhrase`

---

## API Endpoints

All endpoints are accessed via the `POST` method. If security is enabled, include the `Authorization` header.

### Endpoint 1: Pixeldrain
- **URL**: `/api/keep-alive/pixeldrain`
- **Method**: `POST`
- **Payload**:
  ```json
  {
    "url": "https://pixeldrain.com/u/abc123de"
  }
  ```
- **Response (Status 200)**:
  ```json
  {
    "status": "success",
    "service": "pixeldrain",
    "fileId": "abc123de",
    "statusCode": 206
  }
  ```

---

### Endpoint 2: Gofile
- **URL**: `/api/keep-alive/gofile`
- **Method**: `POST`
- **Payload**:
  ```json
  {
    "url": "https://gofile.io/d/abc123de"
  }
  ```
- **Response (Status 200)**:
  ```json
  {
    "status": "success",
    "service": "gofile",
    "folderId": "abc123de",
    "filesProcessed": [
      {
        "id": "file-uuid-001",
        "name": "episode-01.mp4",
        "success": true,
        "status": 206
      }
    ]
  }
  ```

---

### Endpoint 3: Krakenfiles
- **URL**: `/api/keep-alive/krakenfiles`
- **Method**: `POST`
- **Payload**:
  ```json
  {
    "url": "https://krakenfiles.com/view/abc123de/file.html"
  }
  ```
- **Response (Status 200)**:
  ```json
  {
    "status": "success",
    "service": "krakenfiles",
    "fileId": "abc123de",
    "statusCode": 206
  }
  ```

---

## External Automation Examples

You can automate maintenance by scheduling a cron job on your main website to call these endpoints every 15 to 20 days.

### PHP Cron Script
```php
<?php
$service = "pixeldrain"; // Can be pixeldrain, gofile, or krakenfiles
$file_url = "https://pixeldrain.com/u/abc123de";
$api_endpoint = "https://your-project.pages.dev/api/keep-alive/" . $service;
$access_token = "YourCustomSecureSecretPhrase";

$ch = curl_init($api_endpoint);
$payload = json_encode(array("url" => $file_url));

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
    // Record last pinged timestamp inside your database
}
?>
```

### Node.js Script
```javascript
async function keepLinkAlive(service, fileUrl) {
  const apiEndpoint = `https://your-project.pages.dev/api/keep-alive/${service}`;
  const accessToken = "YourCustomSecureSecretPhrase";

  try {
    const res = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ url: fileUrl })
    });
    
    const data = await res.json();
    return data.status === 'success';
  } catch (err) {
    console.error('Failed to trigger maintenance task:', err.message);
    return false;
  }
}
```
