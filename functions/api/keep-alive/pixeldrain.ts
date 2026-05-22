const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const onRequestPost: PagesFunction<{ API_ACCESS_TOKEN?: string }> = async (context) => {
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

    // Extract Pixeldrain file ID
    const match = url.match(/(?:\/u\/|\/file\/)?([a-zA-Z0-9_-]+)$/);
    const fileId = match ? match[1] : null;

    if (!fileId) {
      return new Response(JSON.stringify({ error: 'Invalid Pixeldrain URL or ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Ping the file using 1-byte Range request
    const targetUrl = `https://pixeldrain.com/api/file/${fileId}`;
    const pingResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Range': 'bytes=0-0',
      },
    });

    const success = pingResponse.ok || pingResponse.status === 206;

    return new Response(
      JSON.stringify({
        status: success ? 'success' : 'failed',
        service: 'pixeldrain',
        fileId,
        statusCode: pingResponse.status,
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
