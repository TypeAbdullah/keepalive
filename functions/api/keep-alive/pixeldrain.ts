const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const onRequestPost: PagesFunction<{ 
  API_ACCESS_TOKEN?: string;
  PIXELDRAIN_API_KEY?: string; // Add your free Pixeldrain API Key here
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

    const match = url.match(/(?:\/u\/|\/file\/)?([a-zA-Z0-9_-]+)$/);
    const fileId = match ? match[1] : null;

    if (!fileId) {
      return new Response(JSON.stringify({ error: 'Invalid Pixeldrain URL or ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const targetUrl = `https://pixeldrain.com/api/file/${fileId}`;
    
    // Set up request headers with browser impersonation
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Range': 'bytes=0-0',
      'Origin': 'https://pixeldrain.com',
      'Referer': `https://pixeldrain.com/u/${fileId}`,
      'Accept': '*/*',
    };

    // If a Pixeldrain API Key is configured, authenticate via Basic Auth
    const apiKey = env.PIXELDRAIN_API_KEY;
    if (apiKey) {
      // Pixeldrain expects Basic Auth with empty username and API key as password
      const credentials = btoa(`:${apiKey}`);
      headers['Authorization'] = `Basic ${credentials}`;
    }

    const pingResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: headers,
    });

    const success = pingResponse.ok || pingResponse.status === 206;

    // If it still returns a 403, advise the user to provide an API key
    let message = undefined;
    if (pingResponse.status === 403 && !apiKey) {
      message = "Pixeldrain returned 403. This is commonly caused by shared serverless IP limits. To fix this, create a free Pixeldrain account and add PIXELDRAIN_API_KEY to your Cloudflare env settings.";
    }

    return new Response(
      JSON.stringify({
        status: success ? 'success' : 'failed',
        service: 'pixeldrain',
        fileId,
        statusCode: pingResponse.status,
        message,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
