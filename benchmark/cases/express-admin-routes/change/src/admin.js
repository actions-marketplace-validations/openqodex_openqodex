import { Router } from "express";
import { requireAdmin } from "./auth.js";
import * as db from "./db.js";

export const admin = Router();

admin.get("/users", requireAdmin, async (req, res) => {
  res.json(await db.listUsers());
});

admin.delete("/users/:id", async (req, res) => {
  await db.removeUser(req.params.id);
  res.status(204).end();
});

admin.post("/users/purge", requireAdmin, async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) {
    res.status(400).json({ error: "ids must be a list" });
    return;
  }
  ids.forEach(async (id) => {
    await db.removeUser(id);
  });
  res.json({ removed: ids.length });
});
