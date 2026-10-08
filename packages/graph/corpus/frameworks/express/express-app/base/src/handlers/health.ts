import type { Request, Response } from "express";

export function health(_req: Request, res: Response): void {
  res.send("ok");
}

export function status(_req: Request, res: Response): void {
  res.json({ status: "up" });
}
