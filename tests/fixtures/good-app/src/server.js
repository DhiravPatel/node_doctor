import express from "express";
import cors from "cors";
import users from "./routes/users.js";
import orders from "./routes/orders.js";
import { PORT } from "./config.js";

const ALLOWED_ORIGINS = ["https://app.example.com", "https://admin.example.com"];

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

app.use("/users", users);
app.use("/orders", orders);

// 4-arg error-handling middleware.
app.use((err, req, res, next) => {
  res.status(500).json({ error: "internal" });
});

const server = app.listen(PORT);

// Graceful shutdown: drain, then exit OUTSIDE any request.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

export default app;
