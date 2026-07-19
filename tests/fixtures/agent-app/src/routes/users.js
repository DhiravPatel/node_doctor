import { Router } from "express";
import fs from "node:fs";
import { prisma } from "../db.js";

const router = Router();

// BUG: express-async-handler-unprotected (+ no-sync-io-in-request-path).
router.get("/:id", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  const template = fs.readFileSync("./templates/user.html", "utf8");
  res.send(template + user.name);
});

// BUG: no-query-in-loop (N+1).
router.post("/bulk", async (req, res) => {
  const orders = await prisma.order.findMany();
  for (const order of orders) {
    order.items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
  }
  res.json(orders);
});

// BUG: express-missing-return-after-response — guard has no return.
router.post("/login", async (req, res) => {
  if (!req.body.email) {
    res.status(400).json({ error: "email required" });
  }
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  res.json(user);
});

export default router;
