import { Router } from "express";
import { createUser, getUser, listUsers, removeUser } from "../handlers/users.js";
import { validate } from "../middleware.js";

export const usersRouter = Router();

usersRouter.get("/", listUsers);
usersRouter.get("/:id", getUser);
usersRouter.post("/", validate, createUser);
usersRouter.delete("/:id", removeUser);
