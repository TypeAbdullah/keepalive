interface GofileFileResult {
  id: string;
  name: string;
  success: boolean;
  status: number;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LANGUAGE = 'en-US';

/**
 * Generates the X-Website-Token using the standard Web Crypto API
 */
async function generateWT(token: string): Promise<string> {
  const t4 = Math.floor(Date.now() / 1000 / 14400); // 4-hour window
  const salt = 'gf2026x'; // Gofile salt
  const data = `${USER_AGENT}::${LANGUAGE}::${token}::${t4}::${salt}`;

  const msgBuffer = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates an anonymous guest session token
 */
async function fetchGuestToken(): Promise<string> {
  const response = await fetch('https://api.gofile.io/accounts', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
  });
  const data = (await response.json()) as any;
  if (data.status === 'ok') {
    return data.data.token;
  }
  throw new Error(`Gofile rejected session creation`);
}

/**
 * Entry point for POST requests on Cloudflare Pages Functions
 */
export const onRequestPost: PagesFunction<{ API_ACCESS_TOKEN?: string }> = async (context) => {
  try {
    const { request, env } = context;

    // 1. Optional API Token Check (if configured in Cloudflare environment dashboard)
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

    // 2. Parse request payload
    const body = (await request.json()) as any;
    const { url, token: customToken } = body;

    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing parameter "url"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract content ID
    const match = url.match(/(?:\/d\/)?([a-zA-Z0-9_-]+)$/);
    const contentId = match ? match[1] : null;

    if (!contentId) {
      return new Response(JSON.stringify({ error: 'Invalid Gofile URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Authenticate with Gofile
    const token = customToken || (await fetchGuestToken());
    const wt = await generateWT(token);

    // 4. Fetch list of files
    const folderUrl = `https://api.gofile.io/contents/${contentId}?contentFilter=&page=1&pageSize=1000&sortField=name&sortDirection=1`;
    const contentRes = await fetch(folderUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Website-Token': wt,
        'Accept-Language': LANGUAGE,
      },
    });

    const folderData = (await contentRes.json()) as any;
    if (folderData.status !== 'ok') {
      return new Response(JSON.stringify({ error: `Gofile API returned status: ${folderData.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const children = folderData.data.children;
    if (!children) {
      return new Response(JSON.stringify({ status: 'success', data: { folderId: contentId, filesProcessed: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 5. Ping files using Range headers to simulate a download hit
    const filesProcessed: GofileFileResult[] = [];
    for (const key of Object.keys(children)) {
      const child = children[key];
      if (child.type === 'file' && child.link) {
        try {
          const pingRes = await fetch(child.link, {
            method: 'GET',
            headers: {
              'User-Agent': USER_AGENT,
              'Range': 'bytes=0-0',
            },
          });

          filesProcessed.push({
            id: child.id,
            name: child.name,
            success: pingRes.ok || pingRes.status === 206,
            status: pingRes.status,
          });
        } catch {
          filesProcessed.push({
            id: child.id,
            name: child.name,
            success: false,
            status: 500,
          });
        }
      }
    }

    return new Response(JSON.stringify({ status: 'success', data: { folderId: contentId, filesProcessed } }), {
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
