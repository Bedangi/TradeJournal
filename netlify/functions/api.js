"use strict";

const serverless = require("serverless-http");
const app = require("../../server");

const FUNCTION_PATH = "/.netlify/functions/api";
const expressHandler = serverless(app);

function rewriteFunctionPath(path) {
  if (path === FUNCTION_PATH) return "/api";
  if (path.startsWith(`${FUNCTION_PATH}/`)) {
    return `/api${path.slice(FUNCTION_PATH.length)}`;
  }
  return path;
}

exports.handler = (event, context) => {
  const normalizedEvent = { ...event };
  ["path", "rawPath", "requestPath"].forEach(key => {
    if (typeof normalizedEvent[key] === "string") {
      normalizedEvent[key] = rewriteFunctionPath(normalizedEvent[key]);
    }
  });
  return expressHandler(normalizedEvent, context);
};
