import express from "express";
import type { Request, Response } from "express";
import { status } from "./handlers/health.js";

export const admin = express();

function stats(_req: Request, res: Response): void {
  res.json({ uptime: process.uptime() });
}

admin.get("/health", status);
admin.get("/stats", stats);

admin.listen(3001);
