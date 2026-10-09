import { allUsers, findUser, saveUser } from "../store.js";

export function listUsers(_req, res) {
  res.json(allUsers());
}

export function getUser(req, res) {
  const { userId } = req.params;
  const user = findUser(userId);
  if (!user) {
    res.status(404).json({ error: `no user with id ${userId}` });
    return;
  }
  res.json({ ...user, fetchedAt: new Date().toISOString() });
}

export function createUser(req, res) {
  res.status(201).json(saveUser(req.body.name));
}
