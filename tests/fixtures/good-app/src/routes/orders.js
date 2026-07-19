import { Router } from "express";
import path from "node:path";
import pLimit from "p-limit";
import { asyncHandler } from "../middleware.js";
import { prisma } from "../db.js";

const router = Router();
const UPLOAD_ROOT = path.resolve("./uploads");

router.get(
  "/",
  asyncHandler(async (req, res) => {
    // One round trip with eager loading — no N+1 — and a bounded page.
    const orders = await prisma.order.findMany({
      include: { items: true },
      take: 50,
      skip: Number(req.query.offset) || 0,
    });
    res.json(orders);
  }),
);

router.get(
  "/export/:name",
  asyncHandler(async (req, res) => {
    const full = path.resolve(UPLOAD_ROOT, req.params.name);
    if (!full.startsWith(UPLOAD_ROOT + path.sep)) {
      return res.status(400).json({ error: "bad path" });
    }
    res.sendFile(full);
  }),
);

router.post(
  "/sync",
  asyncHandler(async (req, res) => {
    const limit = pLimit(5);
    const partners = await prisma.partner.findMany({ take: 100 });
    const results = await Promise.all(
      partners.map((p) =>
        limit(() => fetch(p.url, { signal: AbortSignal.timeout(5_000) })),
      ),
    );
    res.json({ synced: results.length });
  }),
);

export default router;
