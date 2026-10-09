import { allUsers, findUser, saveUser } from "../store.js";

export function listUsers(_req, res) {
  res.json(allUsers());
}

export function getUser(req, res) {
  const user = findUser(req.params.id);
  if (!user) {
    res.status(404).json({ error: "no such user" });
    return;
  }
  res.json(user);
}

export function createUser(req, res) {
  res.status(201).json(saveUser(req.body.name));
}
