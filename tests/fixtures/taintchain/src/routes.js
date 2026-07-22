import { lookup } from "./service.js";
import { safeLookup } from "./safe.js";
app.get("/u",(req,res)=>{ res.json(lookup(req.query.name)); });
app.get("/s",(req,res)=>{ res.json(safeLookup(req.query.name)); });
