// GET /api/login — the app is served offline-first, so it never reaches the network on its own
// navigation. Opening this path goes through Cloudflare Access (sign in again when the session
// has expired) and then returns to the app.
export async function onRequestGet({ request }) {
  return Response.redirect(new URL('/', request.url).toString(), 302);
}
