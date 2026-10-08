import { Router } from "express";
import { requireAdmin } from "./auth.js";
import * as db from "./db.js";

export const admin = Router();

admin.get("/users", requireAdmin, async (req, res) => {
  res.json(await db.listUsers());
});
