import { denyDesktop, desktopAuthState } from "@/lib/auth";
import { getShared, subscribe } from "@/lib/desktop-sync";
import { subscribeChanges } from "@/lib/change-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  await getShared();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { cleanup(); }
      };
      const unsubscribe = subscribe((event) => write(`event: state\ndata: ${JSON.stringify(event)}\n\n`));
      const stopChanges = subscribeChanges((topic) => write(`event: refresh\ndata: ${JSON.stringify({ topic })}\n\n`));
      const heartbeat = setInterval(() => {
        write(": ping\n\n");
        void desktopAuthState(req.headers.get("cookie") ?? undefined).then((ok) => {
          if (ok === false) { write("event: auth\ndata: {}\n\n"); cleanup(); }
        });
      }, 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        stopChanges();
        clearInterval(heartbeat);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", cleanup);
      if (req.signal.aborted) cleanup();
      else write("event: hello\ndata: {}\n\n");
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  } });
}
