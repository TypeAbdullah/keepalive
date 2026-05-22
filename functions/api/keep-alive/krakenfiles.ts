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

    // Extract Krakenfiles ID
    const match = url.match(/(?:\/view\/)?([a-zA-Z0-9_-]+)(?:\/file\.html)?$/);
    const fileId = match ? match[1] : null;

    if (!fileId) {
      return new Response(JSON.stringify({ error: 'Invalid Krakenfiles URL or ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Fetch file page to retrieve session cookies and the download token
    const viewUrl = `https://krakenfiles.com/view/${fileId}/file.html`;
    const pageResponse = await fetch(viewUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!pageResponse.ok) {
      return new Response(JSON.stringify({ error: 'Failed to access the Krakenfiles page' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const html = await pageResponse.text();
    const cookies = pageResponse.headers.get('set-cookie') || '';

    // Extract token inside the download form
    const tokenMatch = html.match(/name="token"\s+value="([^"]+)"/);
    const downloadToken = tokenMatch ? tokenMatch[1] : null;

    if (!downloadToken) {
      return new Response(JSON.stringify({ error: 'Failed to resolve download security token' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Perform the download link request (generates the temporary direct download URL)
    const postUrl = `https://krakenfiles.com/download/${fileId}`;
    const formData = new URLSearchParams();
    formData.append('token', downloadToken);

    const downloadResponse = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'Referer': viewUrl,
      },
      body: formData.toString(),
    });

    const downloadData = (await downloadResponse.json()) as any;
    const directDownloadUrl = downloadData.url;

    if (!directDownloadUrl) {
      return new Response(JSON.stringify({ error: 'Failed to obtain direct download link' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Ping the direct CDN link using 1-byte Range request
    const pingResponse = await fetch(directDownloadUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Range': 'bytes=0-0',
        'Cookie': cookies,
      },
    });

    const success = pingResponse.ok || pingResponse.status === 206;

    return new Response(
      JSON.stringify({
        status: success ? 'success' : 'failed',
        service: 'krakenfiles',
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
