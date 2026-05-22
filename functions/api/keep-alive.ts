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
 * Generates Gofile's dynamic HMAC security token
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
 * Creates an anonymous guest token
 */
async function fetchGuestToken(): Promise<string> {
  const response = await fetch('https://api.gofile.io/accounts', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  });
  const data = (await response.json()) as any;
  if (data.status === 'ok') return data.data.token;
  throw new Error('Gofile guest account creation failed');
}

/**
 * Fetch with an exponential backoff retry mechanism
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, backoff = 500): Promise<Response> {
  try {
    const response = await fetch(url, options);
    if (response.ok || response.status === 206) return response;
    
    // Retry on standard rate-limit (429) or transient server failures (5xx)
    if ((response.status === 429 || response.status >= 500) && retries > 0) {
      await delay(backoff);
      return fetchWithRetry(url, options, retries - 1, backoff * 2);
    }
    return response;
  } catch (err) {
    if (retries > 0) {
      await delay(backoff);
      return fetchWithRetry(url, options, retries - 1, backoff * 2);
    }
    throw err;
  }
}

/**
 * Main logical function that recursively scans and pings Gofile content
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

  // Track visited folders to prevent infinite loops (if circular symlinks are ever introduced)
  const visitedFolders = new Set<string>();
  const folderQueue: string[] = [rootFolderId];

  while (folderQueue.length > 0) {
    const currentFolderId = folderQueue.shift()!;
    if (visitedFolders.has(currentFolderId)) continue;
    visitedFolders.add(currentFolderId);
    
    totalFoldersProcessed++;

    const folderUrl = `https://api.gofile.io/contents/${currentFolderId}?contentFilter=&page=1&pageSize=1000&sortField=name&sortDirection=1`;
    const res = await fetch(folderUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${token}`,
        'X-Website-Token': wt,
        'Accept-Language': LANGUAGE,
      },
    });

    const body = (await res.json()) as any;
    if (body.status !== 'ok') continue; // Skip failed folder queries

    const children = body.data.children;
    if (!children) continue;

    for (const key of Object.keys(children)) {
      const child = children[key];

      // If it's a nested subfolder, push to queue to crawl it
      if (child.type === 'folder') {
        folderQueue.push(child.id);
      } 
      // If it's a file, perform the simulated download
      else if (child.type === 'file' && child.link) {
        const fileSize = child.size || 0;
        totalBytesProcessed += fileSize;

        await delay(options.delayMs); // Throttling delay

        let pingStatus = 500;
        let success = false;
        let attempts = 1;

        try {
          const startTimePing = Date.now();
          const pingRes = await fetchWithRetry(child.link, {
            method: 'GET',
            headers: {
              'User-Agent': USER_AGENT,
              'Range': 'bytes=0-0', // Download exactly 1 byte
            },
          });
          
          pingStatus = pingRes.status;
          success = pingRes.ok || pingRes.status === 206;
        } catch {
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
  
  // 1 byte was downloaded per successful file, rest of file size is "bandwidth saved"
  const bandwidthSavedBytes = totalBytesProcessed - (totalSuccessfulPings * 1);

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
 * Pages Function Handler
 */
export const onRequestPost: PagesFunction<{ API_ACCESS_TOKEN?: string }> = async (context) => {
  const { request, env, waitUntil } = context;

  try {
    // 1. Optional API Token Check
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

    // 2. Parse request parameters
    const body = (await request.json()) as any;
    const { url, token: customToken, webhookUrl, delayMs = 200 } = body;

    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing parameter "url"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const match = url.match(/(?:\/d\/)?([a-zA-Z0-9_-]+)$/);
    const contentId = match ? match[1] : null;

    if (!contentId) {
      return new Response(JSON.stringify({ error: 'Invalid Gofile URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const token = customToken || (await fetchGuestToken());
    const wt = await generateWT(token);

    // Mode A: Async Execution (If Webhook is provided)
    if (webhookUrl) {
      // Execute the task asynchronously inside the background execution thread
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

          // Deliver results payload to the designated Webhook URL
          try {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
          } catch (webhookErr) {
            console.error('Webhook payload delivery failed:', webhookErr);
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

    // Mode B: Synchronous Execution (Returns output inside HTTP response directly)
    const results = await processKeepAlive(contentId, token, wt, { delayMs });
    return new Response(JSON.stringify({ status: 'success', data: results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
