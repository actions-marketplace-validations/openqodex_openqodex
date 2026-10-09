import express from "express";
import { ping } from "./ping.js";

const app = express();
app.get("/ping", ping);
app.listen(8080);
