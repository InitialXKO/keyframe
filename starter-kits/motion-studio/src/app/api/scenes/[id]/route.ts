import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/scenes/[id] — load one scene */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const scene = await db.scene.findUnique({ where: { id } });
    if (!scene) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ scene });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** PUT /api/scenes/[id] — update a scene */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as {
      title?: string;
      durationMs?: number;
      data?: unknown;
    };

    const data: { title?: string; durationMs?: number; data?: string } = {};
    if (body.title) data.title = body.title.slice(0, 120);
    if (typeof body.durationMs === "number")
      data.durationMs = Math.max(500, Math.min(20000, Math.round(body.durationMs)));
    if (typeof body.data !== "undefined") data.data = JSON.stringify(body.data);

    const scene = await db.scene.update({ where: { id }, data });
    return NextResponse.json({ id: scene.id, updatedAt: scene.updatedAt });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** PATCH /api/scenes/[id] — lightweight metadata write (starred / title), no data roundtrip */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { starred?: boolean; title?: string };
    const data: { starred?: boolean; title?: string } = {};
    if (typeof body.starred === "boolean") data.starred = body.starred;
    if (typeof body.title === "string") {
      const t = body.title.trim().slice(0, 120);
      if (!t) return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
      data.title = t;
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    const scene = await db.scene.update({
      where: { id },
      data,
      select: { id: true, starred: true, title: true },
    });
    return NextResponse.json(scene);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** DELETE /api/scenes/[id] */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.scene.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
