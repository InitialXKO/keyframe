import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/scenes — list saved scenes (metadata + thumbnail + structure stats) */
export async function GET() {
  try {
    const scenes = await db.scene.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, durationMs: true, thumb: true, starred: true, createdAt: true, updatedAt: true, data: true },
    });
    // v11: parse the scene JSON server-side to expose lightweight structure
    // stats (element / keyframe counts) so library cards can show them
    // without downloading the full data payload
    const list = scenes.map(({ data, ...meta }) => {
      let elCount = 0;
      let kfCount = 0;
      try {
        const parsed = JSON.parse(data) as { elements?: Array<{ keyframes?: unknown[] }> };
        if (Array.isArray(parsed?.elements)) {
          elCount = parsed.elements.length;
          kfCount = parsed.elements.reduce((acc, el) => acc + (Array.isArray(el?.keyframes) ? el.keyframes.length : 0), 0);
        }
      } catch {
        /* corrupted row — counts stay 0 */
      }
      return { ...meta, elCount, kfCount };
    });
    return NextResponse.json({ scenes: list });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** POST /api/scenes — create or upsert a scene */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      id?: string | null;
      title: string;
      durationMs: number;
      data: unknown;
      thumb?: string | null;
    };

    if (!body?.title || typeof body.data === "undefined") {
      return NextResponse.json({ error: "title and data are required" }, { status: 400 });
    }

    const payload = {
      title: body.title.slice(0, 120),
      durationMs: Math.max(500, Math.min(20000, Math.round(body.durationMs || 4000))),
      data: JSON.stringify(body.data),
      // thumbnail is a small JPEG data URL produced client-side; cap to stay light
      thumb: typeof body.thumb === "string" && body.thumb.length < 200_000 ? body.thumb : null,
    };

    const scene = body.id
      ? await db.scene.update({ where: { id: body.id }, data: payload }).catch(() =>
          db.scene.create({ data: payload })
        )
      : await db.scene.create({ data: payload });

    return NextResponse.json({ id: scene.id, updatedAt: scene.updatedAt });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
