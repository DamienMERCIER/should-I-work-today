export interface FetchCall { url: string; init?: RequestInit }

export function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
