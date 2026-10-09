import { Router as makeRouter } from "express";
import { getItem, listItems } from "../handlers/items.js";
import { asyncHandler } from "../wrap.js";

export const itemsRouter = makeRouter();

itemsRouter.get("/", listItems);
itemsRouter.get("/:id", asyncHandler(getItem));
