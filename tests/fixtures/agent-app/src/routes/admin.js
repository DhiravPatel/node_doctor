import { Router } from "express";
import { exec } from "node:child_process";
import path from "node:path";
import { prisma } from "../db.js";

const router = Router();

// BUG: no-process-exit-in-request-path.
router.get("/shutdown", (req, res) => {
  if (req.query.confirm) process.exit(0);
  res.json({ ok: true });
});

// BUG: no-exec-with-interpolation (command injection).
router.post("/backup", (req, res) => {
  exec(`tar -czf backup.tgz ${req.body.directory}`);
  res.json({ started: true });
});

// BUG: no-path-traversal.
router.get("/files/:name", (req, res) => {
  const full = path.join("./uploads", req.params.name);
  res.sendFile(full);
});

// BUG: no-sql-template-interpolation (SQL injection).
router.get("/raw", (req, res) => {
  const rows = prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${req.query.id}`);
  res.json(rows);
});

export default router;
