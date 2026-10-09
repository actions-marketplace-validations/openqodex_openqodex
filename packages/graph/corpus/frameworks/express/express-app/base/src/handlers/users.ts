import type { Request, Response } from "express";
import { allUsers, deleteUser, findUser, saveUser } from "../store.js";

export function listUsers(_req: Request, res: Response): void {
  res.json(allUsers());
}

export function getUser(req: Request, res: Response): void {
  const user = findUser(req.params.id);
  if (!user) {
    res.status(404).end();
    return;
  }
  res.json(user);
}

export function createUser(req: Request, res: Response): void {
  res.status(201).json(saveUser(req.body.name));
}

export function removeUser(req: Request, res: Response): void {
  deleteUser(req.params.id);
  res.status(204).end();
}
