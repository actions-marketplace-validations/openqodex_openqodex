import express from "express";
import { admin } from "./admin.js";

const app = express();
app.use(express.json());
app.use("/admin", admin);
app.listen(3000, "127.0.0.1");
