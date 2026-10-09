import type { Request, Response } from "express";
import { allUsers, findUser, saveUser } from "../store.js";

export function listUsers(_req: Request, res: Response): void {
  res.json(allUsers());
}

export function getUser(req: Request, res: Response): void {
  const user = findUser(req.params.id);
  if (!user) {
    res.status(404).json({ error: "no such user" });
    return;
  }
  res.json(user);
}

export function createUser(req: Request, res: Response): void {
  res.status(201).json(saveUser(req.body.name));
}
