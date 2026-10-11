#!/usr/bin/env node
// This command checks metadata. A runner must call boardProblems with ready:
// true (or invoke --ready) before spending, after the session records probes.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const https = (value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
};
const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const sha = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const pr = (value) => typeof value === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(value);
const pinnedSource = (value, board, rawOnly = false) => {
  try {
    const url = new URL(value);
    const prefix = url.origin === "https://raw.githubusercontent.com" ? `/${board.repo}/${board.commit}/`
      : !rawOnly && url.origin === "https://github.com" ? `/${board.repo}/blob/${board.commit}/` : null;
    return prefix !== null && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(prefix) && url.pathname.length > prefix.length;
  } catch { return false; }
};

// Retail meter labels encode the model, context, token direction and deployment type.
const meterMatches = (meter, price, modelId, field) => {
  const model = /^gpt-(\d+(?:\.\d+)?(?:-[a-z0-9.]+)?)$/.exec(modelId)?.[1];
  if (!model || price.deploymentType !== "Global Standard") return false;
  const short = typeof price.context === "string" && price.context.startsWith("Short context (");
  const base = typeof price.context === "string" && price.context.startsWith(`GPT ${model} base model;`);
  if (!short && !base) return false;
  const direction = { input: "Inp", cachedInput: "Cd Inp", output: "Opt" }[field];
  const sku = short ? `${model} ShortCo ${direction} Std Gl` : `GPT ${model} ${direction} Gl`;
  const regionTokens = (value) => typeof value === "string" ? value.toLowerCase().trim().split(/\s+/).sort().join(" ") : null;
  return meter.unitOfMeasure === "1M"
    && text(meter.meterName) && meter.meterName.toLowerCase() === `${sku} 1M Tokens`.toLowerCase()
    && text(meter.skuName) && meter.skuName.toLowerCase() === sku.toLowerCase()
    && meter.productName === `Azure OpenAI GPT${model.split(/[.-]/)[0]}`
    && text(price.region) && regionTokens(meter.region) === regionTokens(price.region)
    && meter.armRegionName === price.region.toLowerCase().replace(/\s+/g, "");
};

/** Validate saved facts without fetching data or calling a model. */
export function boardProblems(pins, prices, { ready = false } = {}) {
  const problems = [];
  const need = (ok, name) => { if (!ok) problems.push(`${name} is missing or invalid`); };
  if (!object(pins) || !object(prices)) return ["boards and prices must be objects"];
  need(pins.version === 1, "boards.version");
  need(object(pins.aliases) && Object.keys(pins.aliases).length === 0, "aliases");
  need(object(pins.boards), "boards");
  need(object(pins.deployments), "deployments");

  const checkFile = (file, board, name) => {
    if (!object(file)) { need(false, name); return; }
    need(text(file.path) && !file.path.startsWith("/") && !file.path.split("/").includes(".."), `${name}.path`);
    need(file.url === `https://raw.githubusercontent.com/${board.repo}/${board.commit}/${file.path}`
      && pinnedSource(file.url, board, true), `${name}.url`);
    need(sha(file.sha256, 64), `${name}.sha256`);
  };
  for (const id of ["martian", "aacr", "reviewbench"]) {
    const board = pins.boards?.[id];
    const name = `boards.${id}`;
    if (!object(board)) { need(false, name); continue; }
    need(text(board.repo) && /^[^/]+\/[^/]+$/.test(board.repo), `${name}.repo`);
    need(sha(board.commit, 40), `${name}.commit`);
    need(board.source === `https://github.com/${board.repo}/tree/${board.commit}`, `${name}.source`);
    need(date(board.readDate), `${name}.readDate`);
    need(["MIT", "Apache-2.0"].includes(board.licence), `${name}.licence`);
    checkFile(board.licenceFile, board, `${name}.licenceFile`);
    if (!Array.isArray(board.data) || board.data.length === 0) need(false, `${name}.data`);
    else {
      for (const [i, file] of board.data.entries()) {
        checkFile(file, board, `${name}.data[${i}]`);
        // The agent contract is a supporting document, not a PR dataset.
        if (id !== "reviewbench" || file?.path !== "AGENT_CONTRACT.md") {
          need(Number.isSafeInteger(file?.prCount) && file.prCount > 0, `${name}.data[${i}].prCount`);
        }
      }
      need(new Set(board.data.map((file) => file?.path)).size === board.data.length, `${name}.data paths`);
      const paths = board.data.map((file) => file?.path);
      if (id === "martian") {
        need(board.data.length === 5 && paths.every((path) => /^offline\/golden_comments\/[^/]+\.json$/.test(path)), `${name}.data golden files`);
      } else if (id === "aacr") {
        for (const path of ["dataset/positive_samples.json", "dataset/negative_samples.json"]) need(paths.includes(path), `${name}.data ${path}`);
      } else {
        need(paths.includes("AGENT_CONTRACT.md"), `${name}.data AGENT_CONTRACT.md`);
        if (board.reservedPrUrls !== null) need(paths.includes("corpus/manifest.json"), `${name}.data corpus manifest`);
      }
    }
    const urls = board.reservedPrUrls;
    if (id === "reviewbench" && urls === null && !ready) need(text(board.note), `${name}.note for unavailable reservedPrUrls`);
    else {
      need(Array.isArray(urls) && urls.every(pr) && new Set(urls).size === urls.length, `${name}.reservedPrUrls`);
      const count = id === "martian" ? 50 : id === "reviewbench" ? 219 : 0;
      need(Array.isArray(urls) && urls.length === count, `${name}.reservedPrUrls count`);
    }
    const judge = board.judge;
    need(object(judge) && pinnedSource(judge.source, board), `${name}.judge`);
    if (id === "reviewbench") {
      need(text(judge?.id), `${name}.judge.id`);
      need(sha(judge?.sha256, 64), `${name}.judge.sha256`);
    } else need(judge?.deployment === "judge", `${name}.judge.deployment`);
  }

  need(prices.version === 1, "prices.version");
  need(prices.currency === "USD" && prices.unit === "per-million-tokens", "prices currency and unit");
  need(object(prices.models), "prices.models");
  for (const role of ["reviewer", "judge"]) {
    const deployment = pins.deployments?.[role];
    const name = `deployments.${role}`;
    if (!object(deployment)) { need(false, name); continue; }
    need(text(deployment.id), `${name}.id`);
    need(deployment.provider === "azure-openai", `${name}.provider`);
    need(https(deployment.source), `${name}.source`);
    need(Array.isArray(deployment.roles) && deployment.roles.length > 0 && deployment.roles.every(text), `${name}.roles`);
    need(Object.hasOwn(deployment, "probed") && (deployment.probed === null || (text(deployment.probed) && Number.isFinite(Date.parse(deployment.probed)))), `${name}.probed`);
    need(Object.hasOwn(deployment, "served") && (deployment.served === null || text(deployment.served)), `${name}.served`);
    if (ready) {
      need(text(deployment.probed) && Number.isFinite(Date.parse(deployment.probed)), `${name}.probed before a run`);
      need(text(deployment.served), `${name}.served before a run`);
    }
    const price = prices.models?.[deployment.id];
    if (!object(price)) { need(false, `prices.models.${deployment.id}`); continue; }
    const priceName = `prices.models.${deployment.id}`;
    for (const field of ["input", "cachedInput", "output"]) {
      const fieldName = `${priceName}.${field}`;
      if (price[field] === null) {
        need(text(price.notes?.[field]), `${fieldName} unpriced search note`);
        need(price.meters?.[field] === null, `${fieldName} unpriced meter`);
        continue;
      }
      need(typeof price[field] === "number" && Number.isFinite(price[field]) && price[field] >= 0, fieldName);
      const meter = price.meters?.[field];
      if (!object(meter)) { need(false, `${fieldName}.meter`); continue; }
      for (const key of ["meterName", "productName", "region", "unitOfMeasure"]) need(text(meter[key]), `${fieldName}.${key}`);
      need(meterMatches(meter, price, deployment.id, field), `${fieldName}.meter unit, direction, model and scope`);
      need(https(meter.source), `${fieldName}.source`);
      need(date(meter.readDate), `${fieldName}.readDate`);
    }
    need(https(price.source), `${priceName}.source`);
    need(date(price.readDate), `${priceName}.readDate`);
    need(text(price.deploymentType) && text(price.region) && text(price.context), `${priceName} rate scope`);
  }
  return problems;
}

/** Check field presence only. Never capture, return or log a field value. */
export function azureEnvProblems(content) {
  const problems = [];
  const base = /^[ \t]*(?:export[ \t]+)?(?:AZURE_OPENAI_BASE_URL|OPENAI_BASE_URL|AZURE_OPENAI_ENDPOINT|BASE_URL)[ \t]*=[ \t]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s#'"\r\n]+)[ \t]*(?:#.*)?$/;
  const key = /^[ \t]*(?:export[ \t]+)?(?:AZURE_OPENAI_API_KEY|OPENAI_API_KEY|AZURE_OPENAI_KEY|API_KEY)[ \t]*=[ \t]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s#'"\r\n]+)[ \t]*(?:#.*)?$/;
  const lines = content.split(/\r\n|\n|\r/);
  if (!lines.some((line) => base.test(line))) problems.push("azure.env is missing a nonempty base URL field");
  if (!lines.some((line) => key.test(line))) problems.push("azure.env is missing a nonempty key field");
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--ready")) {
    console.error("Usage: node benchmark/outside/check-boards.mjs [--ready]");
    return 2;
  }
  let pins, prices;
  try {
    pins = JSON.parse(readFileSync(new URL("./boards.json", import.meta.url), "utf8"));
    prices = JSON.parse(readFileSync(new URL("./prices.json", import.meta.url), "utf8"));
  } catch {
    console.error("Board check failed: boards.json or prices.json cannot be read as JSON");
    return 1;
  }
  const problems = boardProblems(pins, prices, { ready: args.includes("--ready") });
  try {
    problems.push(...azureEnvProblems(readFileSync(join(homedir(), ".config/openqodex-bench/azure.env"), "utf8")));
  } catch {
    problems.push("azure.env is missing or unreadable");
  }
  if (problems.length > 0) {
    console.error(`Board check failed:\n${problems.join("\n")}`);
    return 1;
  }
  for (const [id, price] of Object.entries(prices.models)) {
    for (const field of ["input", "cachedInput", "output"]) {
      if (price[field] === null) console.warn(`Warning: ${id}.${field} is unpriced. ${price.notes[field]}`);
    }
  }
  console.log(`Board check passed: 3 boards, 2 deployments, 2 prices. ${args.includes("--ready") ? "Ready for a run." : "Metadata only; deployments remain unprobed until the session records them."}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
