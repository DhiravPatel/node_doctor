import { Router } from "express";
import { asyncHandler } from "../middleware.js";
import { prisma } from "../db.js";

const router = Router();

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      return res.status(404).json({ error: "not found" });
    }
    res.json(user);
  }),
);

router.post(
  "/search",
  asyncHandler(async (req, res) => {
    // Filtering belongs in the query, not a per-row loop.
    const users = await prisma.user.findMany({
      where: { email: { contains: req.body.q } },
      take: 50,
    });
    res.json(users);
  }),
);

export default router;
