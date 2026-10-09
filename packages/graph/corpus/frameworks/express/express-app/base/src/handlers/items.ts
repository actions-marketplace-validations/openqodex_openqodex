import type { Request, Response } from "express";

const items = [{ id: "1", title: "Lamp" }];

export function listItems(_req: Request, res: Response): void {
  res.json(items);
}

export async function getItem(req: Request, res: Response): Promise<void> {
  const item = items.find((i) => i.id === req.params.id);
  res.status(item ? 200 : 404).json(item ?? null);
}
