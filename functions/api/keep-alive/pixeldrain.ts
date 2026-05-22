const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface PixeldrainListResponse {
  id: string;
  files: Array<{
    id: string;
    name: string;
    size: number;
  }>;
}

interface PingResult {
  success: boolean;
  status: number;
  errorDetails?: string;
}

/**
 * Pings a single Pixeldrain file and extracts diagnostic error details on failure
 */
async function pingSingleFile(fileId: string, apiKey?: string): Promise<PingResult> {
  const targetUrl = `https://pixeldrain.com/api/file/${fileId}`;
  
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Origin': 'https://pixeldrain.com',
    'Referer': `https://pixeldrain.com/u/${fileId}`,
    'Accept': '*/*',
  };

  if (apiKey) {
    const credentials = btoa(`:${apiKey}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: headers,
    });

    if (response.ok) {
      // Smart Stream Cancellation: cancel immediately after registering the download hit
      if (response.body) {
        const reader = response.body.getReader();
        try {
          await reader.read();
        } finally {
          await reader.cancel();
        }
      }
      return { success: true, status: response.status };
    }

    // Try to extract the error payload from Pixeldrain on 403 or other failures
    let errorDetails = 'No specific error message returned by Pixeldrain.';
    try {
      const errJson = (await response.json()) as any;
      if (errJson && errJson.message) {
        errorDetails = errJson.message;
      } else if (errJson && errJson.value) {
        errorDetails = errJson.value;
      }
    } catch {
      // Response was not JSON
    }

    return { success: false, status: response.status, errorDetails };

  } catch (err: any) {
    return { success: false, status: 500, errorDetails: err.message };
  }
}

export const onRequestPost: PagesFunction<{ 
  API_ACCESS_TOKEN?: string;
  PIXELDRAIN_API_KEY?: string;
}> = async (context) => {
  try {
    const { request, env } = context;

    // Optional API token check
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

    const { url } = (await request.json()) as any;
    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing parameter "url"' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isList = url.includes('/l/') || url.includes('/api/list/');
    const match = url.match(/(?:\/u\/|\/file\/|\/l\/|\/list\/)?([a-zA-Z0-9_-]+)$/);
    const contentId = match ? match[1] : null;

    if (!contentId) {
      return new Response(JSON.stringify({ error: 'Invalid Pixeldrain URL or ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiKey = env.PIXELDRAIN_API_KEY;
    const filesProcessed: any[] = [];

    // --- CASE A: Handle Album/List ---
    if (isList) {
      const listUrl = `https://pixeldrain.com/api/list/${contentId}`;
      const listRes = await fetch(listUrl, {
        headers: apiKey ? { 'Authorization': `Basic ${btoa(':' + apiKey)}` } : {}
      });

      if (!listRes.ok) {
        return new Response(JSON.stringify({ error: `Failed to fetch Pixeldrain list. Status: ${listRes.status}` }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const listData = (await listRes.json()) as PixeldrainListResponse;
      
      for (const file of listData.files) {
        const pingResult = await pingSingleFile(file.id, apiKey);
        filesProcessed.push({
          id: file.id,
          name: file.name,
          success: pingResult.success,
          status: pingResult.status,
          error: pingResult.errorDetails,
        });
      }

      return new Response(
        JSON.stringify({
          status: 'success',
          service: 'pixeldrain',
          type: 'list-processing',
          listId: contentId,
          filesProcessed,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --- CASE B: Handle Single File ---
    const pingResult = await pingSingleFile(contentId, apiKey);

    const responsePayload: any = {
      status: pingResult.success ? 'success' : 'failed',
      service: 'pixeldrain',
      type: 'single-file-processing',
      fileId: contentId,
      statusCode: pingResult.status,
    };

    if (!pingResult.success) {
      responsePayload.error = pingResult.errorDetails;
    }

    return new Response(
      JSON.stringify(responsePayload),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
