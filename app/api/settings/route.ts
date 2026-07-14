import { publicStore } from "@/lib/serialize";
import { addLog, getStore, mutateStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  let body: { autoFailover?: boolean };
  try {
    body = (await req.json()) as { autoFailover?: boolean };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  await mutateStore((store) => {
    if (typeof body.autoFailover === "boolean") {
      store.settings.autoFailover = body.autoFailover;
      addLog(
        store,
        "switch",
        `Auto-failover ${body.autoFailover ? "enabled" : "disabled"}`,
      );
    }
  });

  return Response.json(publicStore(await getStore()));
}
