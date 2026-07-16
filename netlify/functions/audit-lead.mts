import type { Context, Config } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";

// Captures an email for the (v2) full PDF report. v1 just stores the lead in
// Netlify Blobs — Loops.so / CRM wiring is intentionally deferred.
// NOTE: Blobs, not Mantle — Mantle is being retired, nothing new should go on it.

function leadStore() {
  const isProd = (globalThis as any).Netlify?.context?.deploy?.context === "production";
  return isProd ? getStore("audit-leads") : getDeployStore("audit-leads");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const email = String(body?.email || "").trim().toLowerCase();
  const domain = String(body?.domain || "").trim().toLowerCase();
  const score = Number.isFinite(body?.score) ? Number(body.score) : null;

  if (!EMAIL_RE.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  try {
    const store = leadStore();
    const key = `${Date.now()}-${domain || "unknown"}`;
    await store.setJSON(key, {
      email,
      domain,
      score,
      capturedAt: new Date().toISOString(),
    });
  } catch {
    return json({ error: "Could not save your details right now. Please try again." }, 500);
  }

  return json({ status: "ok" });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/audit-lead",
};
