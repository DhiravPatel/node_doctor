import express from "express";
import { warm } from "./cache.js";

const app = express();

// The handler blocks nothing directly — but it calls warm(), which (two hops
// away, in another file) does a synchronous read. The cross-file rule follows it.
app.get("/warm", (req, res) => {
  res.send(warm());
});

export default app;
