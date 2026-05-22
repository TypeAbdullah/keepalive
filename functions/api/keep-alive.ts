interface GofileFileResult {
  id: string;
  name: string;
  size: number;
  success: boolean;
  status: number;
  attempts: number;
}

interface KeepAliveStats {
  totalFoldersProcessed: number;
  totalFilesProcessed: number;
  totalSuccessfulPings: number;
  totalFailedPings: number;
  totalBytesProcessed: number;
  bandwidthSavedBytes: number;
  elapsedTimeMs: number;
}

interface WebhookPayload {
  status: 'completed' | 'failed';
  folderId: string;
  stats?: KeepAliveStats;
  filesProcessed?: GofileFileResult[];
  error?: string;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LANGUAGE = 'en-US';

// Utility helper for delaying execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generates Gofile's dynamic HMAC security token.
 * The wt token is derived from: SHA256(userAgent + "::" + lang + "::" + token + "::" + timeSlot + "::" + salt)
 * Time slot rotates every 4 hours (14400 seconds). Salt may need updating if Gofile rotates it.
 */
async function generateWT(token: string): Promise<string> {
  const t4 = Math.floor(Date.now() / 1000 / 14400);
  const salt = 'gf2026x';
  const data = `${USER_AGENT}::${LANGUAGE}::${token}::${t4}::${salt}`;

  const msgBuffer = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates an anonymous guest token from Gofile's accounts API.
 */
async function fetchGuestToken(): Promise<string> {
  const response = await fetch('https://api.gofile.io/accounts', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Gofile accounts API returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as any;
  if (data.status === 'ok') return data.data.token;
  throw new Error(`Gofile guest account creation failed: ${JSON.stringify(data)}`);
}

/**
 * Fetch with exponential backoff retry.
 * Retries on 429 (rate limit) and 5xx (transient server errors).
 * Returns the response and how many attempts were made.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  backoff = 500
): Promise<{ response: Response; attempts: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Success or a non-retryable error — return immediately
      if (response.ok || response.status === 206) {
        return { response, attempts: attempt };
      }

      // Retryable statuses: 429 and 5xx
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          await delay(backoff * Math.pow(2, attempt - 1));
          continue;
        }
        // Exhausted retries — return the last response as-is
        return { response, attempts: attempt };
      }

      // Non-retryable HTTP error (e.g. 404, 403) — return immediately
      return { response, attempts: attempt };

    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await delay(backoff * Math.pow(2, attempt - 1));
      }
    }
  }

  // All attempts threw network errors
  throw lastError ?? new Error(`fetchWithRetry failed after ${maxRetries} attempts`);
}

/**
 * Recursively scans all folders and pings every file with a 1-byte Range request,
 * resetting Gofile's 30-day inactivity timer at minimal bandwidth cost.
 */
async function processKeepAlive(
  rootFolderId: string,
  token: string,
  wt: string,
  options: { delayMs: number }
): Promise<{ stats: KeepAliveStats; filesProcessed: GofileFileResult[] }> {

  const startTime = Date.now();
  const filesProcessed: GofileFileResult[] = [];

  let totalFoldersProcessed = 0;
  let totalBytesProcessed = 0;
  let totalSuccessfulPings = 0;
  let totalFailedPings = 0;

  // Visited set prevents infinite loops in case of circular references
  const visitedFolders = new Set<string>();
  const folderQueue: string[] = [rootFolderId];

  while (folderQueue.length > 0) {
    const currentFolderId = folderQueue.shift()!;
    if (visitedFolders.has(currentFolderId)) continue;
    visitedFolders.add(currentFolderId);

    totalFoldersProcessed++;

    const folderUrl = `https://api.gofile.io/contents/${currentFolderId}?contentFilter=&page=1&pageSize=1000&sortField=name&sortDirection=1`;

    let folderRes: Response;
    try {
      const result = await fetchWithRetry(folderUrl, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          'Authorization': `Bearer ${token}`,
          'X-Website-Token': wt,
          'Accept-Language': LANGUAGE,
        },
      });
      folderRes = result.response;
    } catch (err) {
      console.error(`Failed to fetch folder ${currentFolderId}:`, err);
      continue;
    }

    let body: any;
    try {
      body = await folderRes.json();
    } catch {
      console.error(`Failed to parse JSON for folder ${currentFolderId}`);
      continue;
    }

    if (body.status !== 'ok') {
      // Log auth failures so they surface in Cloudflare's real-time function logs
      console.warn(`Folder ${currentFolderId} returned non-ok status: "${body.status}" — message: "${body.message ?? 'none'}"`);
      continue;
    }

    const children = body.data?.children;
    if (!children || typeof children !== 'object') continue;

    for (const key of Object.keys(children)) {
      const child = children[key];

      if (child.type === 'folder') {
        // Queue subfolder for recursive processing
        folderQueue.push(child.id);

      } else if (child.type === 'file' && child.link) {
        const fileSize: number = child.size || 0;
        totalBytesProcessed += fileSize;

        // Throttle requests to avoid hammering Gofile's CDN
        await delay(options.delayMs);

        let pingStatus = 500;
        let success = false;
        let attempts = 0;

        try {
          const { response: pingRes, attempts: pingAttempts } = await fetchWithRetry(
            child.link,
            {
              method: 'GET',
              headers: {
                'User-Agent': USER_AGENT,
                'Range': 'bytes=0-0', // Download exactly 1 byte to reset the inactivity timer
              },
            }
          );

          attempts = pingAttempts;
          pingStatus = pingRes.status;
          success = pingRes.ok || pingRes.status === 206;
        } catch (err) {
          console.error(`Ping failed for file ${child.name} (${child.id}):`, err);
          success = false;
        }

        if (success) {
          totalSuccessfulPings++;
        } else {
          totalFailedPings++;
        }

        filesProcessed.push({
          id: child.id,
          name: child.name,
          size: fileSize,
          success,
          status: pingStatus,
          attempts,
        });
      }
    }
  }

  const elapsedTimeMs = Date.now() - startTime;
  const totalFilesProcessed = filesProcessed.length;

  // Only 1 byte downloaded per successful ping; the rest of the file size counts as saved bandwidth
  const bandwidthSavedBytes = totalBytesProcessed - totalSuccessfulPings;

  return {
    stats: {
      totalFoldersProcessed,
      totalFilesProcessed,
      totalSuccessfulPings,
      totalFailedPings,
      totalBytesProcessed,
      bandwidthSavedBytes,
      elapsedTimeMs,
    },
    filesProcessed,
  };
}

/**
 * Cloudflare Pages Function handler for POST /api/keep-alive
 */
export const onRequestPost: PagesFunction<{ API_ACCESS_TOKEN?: string }> = async (context) => {
  const { request, env, waitUntil } = context;

  try {
    // 1. Optional Bearer token auth guard
    const secretToken = env.API_ACCESS_TOKEN;
    if (secretToken) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || authHeader !== `Bearer ${secretToken}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized Access' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 2. Parse and validate request body
    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Request body must be valid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { url, token: customToken, webhookUrl, delayMs = 200 } = body;

    if (!url || typeof url !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing or invalid parameter "url"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract folder ID from a full URL (e.g. https://gofile.io/d/AbC123) or a bare ID
    const match = url.trim().match(/(?:\/d\/)?([a-zA-Z0-9_-]+)$/);
    const contentId = match ? match[1] : null;

    if (!contentId) {
      return new Response(JSON.stringify({ error: 'Could not extract a valid Gofile folder ID from the provided URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Obtain a guest token if a custom one wasn't supplied
    let token: string;
    try {
      token = customToken || (await fetchGuestToken());
    } catch (err: any) {
      return new Response(JSON.stringify({ error: `Failed to obtain Gofile token: ${err.message}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const wt = await generateWT(token);

    // ── Mode A: Asynchronous (webhook provided) ────────────────────────────────
    if (webhookUrl && typeof webhookUrl === 'string') {

      waitUntil(
        (async () => {
          let payload: WebhookPayload;
          try {
            const results = await processKeepAlive(contentId, token, wt, { delayMs });
            payload = {
              status: 'completed',
              folderId: contentId,
              stats: results.stats,
              filesProcessed: results.filesProcessed,
            };
          } catch (asyncErr: any) {
            payload = {
              status: 'failed',
              folderId: contentId,
              error: asyncErr.message,
            };
          }

          try {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
          } catch (webhookErr) {
            console.error('Webhook delivery failed:', webhookErr);
          }
        })()
      );

      return new Response(
        JSON.stringify({
          status: 'processing',
          message: 'Asynchronous task scheduled successfully. Results will be delivered to the webhook.',
          folderId: contentId,
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Mode B: Synchronous (returns result directly) ─────────────────────────
    const results = await processKeepAlive(contentId, token, wt, { delayMs });
    return new Response(JSON.stringify({ status: 'success', data: results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message ?? 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
