#!/usr/bin/env node
import { readFileSync } from "node:fs";

if (!process.argv.includes("POST")) {
  process.stdout.write(process.env.TEST_CURRENT_HEAD ?? "");
} else {
  const request: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (typeof request !== "object" || request === null || !("body" in request)) {
    throw new Error("Missing posting body");
  }
  process.stdout.write(JSON.stringify({ id: 101, body: request.body }));
}
