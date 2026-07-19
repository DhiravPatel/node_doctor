import express from "express";
import cors from "cors";
import users from "./routes/users.js";
import admin from "./routes/admin.js";

const app = express();

// BUG: cors-credentials-reflect — reflects any origin with credentials.
app.use(cors({ origin: true, credentials: true }));

app.use("/users", users);
app.use("/admin", admin);

export default app;
