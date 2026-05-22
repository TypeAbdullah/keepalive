# Advanced Gofile Link Saver API

An optimized serverless application designed to keep Gofile links active. It crawls folders recursively, updates Gofile's 30-day inactivity expiration countdown using low-bandwidth range queries, and processes large-scale jobs asynchronously via custom webhooks.

---

## Technical Features

- **Nested Directory Crawling**: Recursively processes children of type `folder` to resolve highly complex nesting.
- **Asynchronous Processing (`ctx.waitUntil`)**: Immediately releases the HTTP caller while executing deep directory maintenance routines behind the scenes.
- **Automatic Webhook Dispatches**: Transmits diagnostic results to your parent website when background tasks are completed.
- **Throttling Engine**: Protects server execution and targets Gofile's CDN cleanly using configurable per-request sleep delays.
- **Exponential Backoff**: Mitigates 429 Rate Limiting or transient 502/503 service issues.

---

## Deployment to Cloudflare Pages

### Option A: Manual Setup via GitHub
1. Upload this codebase to a private GitHub repository.
2. In the [Cloudflare Dashboard](https://dash.cloudflare.com), go to **Workers & Pages** -> **Create** -> **Pages**.
3. Select your repository.
4. Leave **Build command** empty.
5. Set the **Build output directory** to `public`.
6. Click **Save and Deploy**.

### Option B: Securing your Endpoint
If you do not want random visitors to access your API, secure it using a shared secret token:
1. In the Pages project settings on Cloudflare, go to **Settings** -> **Variables**.
2. Add a new Environment Variable:
   - **Name**: `API_ACCESS_TOKEN`
   - **Value**: `YourSecurePasswordHere`
3. Save and redeploy. All `/api/keep-alive` calls must now include the header: `Authorization: Bearer YourSecurePasswordHere`.

---

## API Documentation

### POST `/api/keep-alive`

#### Request JSON Schema
```json
{
  "url": "https://gofile.io/d/AbC123",
  "delayMs": 250,
  "webhookUrl": "https://your-anime-site.com/gofile-webhook-callback"
}
```

- `url` (*Required*): The Gofile share link or content ID.
- `delayMs` (*Optional*, Default: `200`): Artificial pause between file downloads to prevent rate-limiting.
- `webhookUrl` (*Optional*): If included, the API switches to **asynchronous non-blocking mode**, responding instantly with `202 Accepted` and running the task in the background.

#### Synchronous Response (Status 200)
Returned when no `webhookUrl` is configured.
```json
{
  "status": "success",
  "data": {
    "stats": {
      "totalFoldersProcessed": 2,
      "totalFilesProcessed": 10,
      "totalSuccessfulPings": 10,
      "totalFailedPings": 0,
      "totalBytesProcessed": 10737418240,
      "bandwidthSavedBytes": 10737418230,
      "elapsedTimeMs": 2842
    },
    "filesProcessed": [
      {
        "id": "abc-123",
        "name": "episode-01.mp4",
        "size": 1073741824,
        "success": true,
        "status": 206,
        "attempts": 1
      }
    ]
  }
}
```

#### Asynchronous Response (Status 202)
Returned when a `webhookUrl` is specified.
```json
{
  "status": "processing",
  "message": "Asynchronous task scheduled successfully. Results will be delivered to the webhook.",
  "folderId": "AbC123"
}
```

---

## Webhook Handling on Your Site (Receiver)

When running in asynchronous mode, your server will receive a POST callback when the task completes.

#### Payload Sent to Your Webhook:
```json
{
  "status": "completed",
  "folderId": "AbC123",
  "stats": {
    "totalFoldersProcessed": 1,
    "totalFilesProcessed": 15,
    "totalSuccessfulPings": 14,
    "totalFailedPings": 1,
    "totalBytesProcessed": 15000000,
    "bandwidthSavedBytes": 14999986,
    "elapsedTimeMs": 4200
  },
  "filesProcessed": [
    {
      "id": "file-1",
      "name": "ep1.mp4",
      "size": 1000000,
      "success": true,
      "status": 206,
      "attempts": 1
    },
    {
      "id": "file-2",
      "name": "ep2.mp4",
      "size": 1000000,
      "success": false,
      "status": 404,
      "attempts": 1
    }
  ]
}
```

### Implementing the Webhook on Your Website (Node.js/Express)
```javascript
app.post('/gofile-webhook-callback', (req, res) => {
  const { status, folderId, stats, filesProcessed, error } = req.body;

  if (status === 'failed') {
    console.error(`Gofile folder maintenance failed for ${folderId}: ${error}`);
    return res.sendStatus(200);
  }

  console.log(`Process Complete for Folder: ${folderId}`);
  console.log(`Pings Successful: ${stats.totalSuccessfulPings}/${stats.totalFilesProcessed}`);

  // Loop through results to update database or flag offline files
  filesProcessed.forEach(file => {
    if (!file.success) {
      console.warn(`File ${file.name} (ID: ${file.id}) returned failure status: ${file.status}. It may have been deleted or DMCA-removed.`);
      // Run internal logic to mark this item as unavailable or schedule a re-upload
    }
  });

  res.sendStatus(200);
});
```
