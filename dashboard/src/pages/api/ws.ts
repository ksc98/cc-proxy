import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { readUserHash } from "@/lib/cookie";
import { getLinkedHash, readCfAccessEmail } from "@/lib/links";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const cfEmail = readCfAccessEmail(request);
  const linked = await getLinkedHash(env.SESSION, cfEmail);
  const cookieHash = readUserHash(request.headers.get("cookie"));
  const userHash = linked ?? cookieHash;
  if (!userHash) {
    return new Response("unauthenticated", { status: 401 });
  }

  const upgrade = request.headers.get("upgrade");
  if (upgrade?.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  const id = env.USER_STORE.idFromName(userHash);
  const stub = env.USER_STORE.get(id);
  return stub.fetch("https://store/ws", { headers: request.headers });
};
