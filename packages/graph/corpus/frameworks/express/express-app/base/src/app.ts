import express from "express";
import { itemsRouter } from "./routes/items.js";
import { usersRouter } from "./routes/users.js";
import { logRequests, onError, requireAuth } from "./middleware.js";
import { health, status } from "./handlers/health.js";

export const app = express();

app.use(logRequests);
app.get("/health", health);
app.get("/health", status);
app.use("/users", requireAuth, usersRouter);
app.use("/items", itemsRouter);
app.use(onError);

const version = process.env.API_VERSION ?? "1";
app.get(`/v${version}/status`, status);

app.listen(3000);
