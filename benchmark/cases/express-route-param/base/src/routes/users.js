import { Router } from "express";
import { createUser, getUser, listUsers } from "../handlers/users.js";

export const usersRouter = Router();

usersRouter.get("/", listUsers);
usersRouter.get("/:id", getUser);
usersRouter.post("/", createUser);
