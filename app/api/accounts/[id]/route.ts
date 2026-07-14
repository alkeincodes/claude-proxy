import { publicStore } from "@/lib/serialize";
import { addLog, getStore, mutateStore } from "@/lib/store";

export const dynamic = "force-dynamic";

interface PatchBody {
  action?: "activate";
  name?: string;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    body = {};
  }

  const found = await mutateStore((store) => {
    const account = store.accounts.find((a) => a.id === id);
    if (!account) return false;
    if (body.name?.trim()) account.name = body.name.trim();
    if (body.action === "activate" && store.activeAccountId !== account.id) {
      const previous = store.accounts.find((a) => a.id === store.activeAccountId);
      store.activeAccountId = account.id;
      addLog(
        store,
        "switch",
        previous
          ? `Switched: "${previous.name}" → "${account.name}"`
          : `Activated "${account.name}"`,
      );
    }
    return true;
  });

  if (!found) return Response.json({ error: "account not found" }, { status: 404 });
  return Response.json(publicStore(await getStore()));
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const found = await mutateStore((store) => {
    const index = store.accounts.findIndex((a) => a.id === id);
    if (index === -1) return false;
    const [removed] = store.accounts.splice(index, 1);
    if (store.activeAccountId === id) {
      store.activeAccountId = store.accounts[0]?.id ?? null;
    }
    addLog(store, "import", `Removed "${removed.name}"`);
    return true;
  });

  if (!found) return Response.json({ error: "account not found" }, { status: 404 });
  return Response.json(publicStore(await getStore()));
}
