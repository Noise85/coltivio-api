import "dotenv/config";
import { createConfig, Documentation } from "express-zod-api";
import { routing } from "../src/routing";
import { writeFileSync } from "fs";

const config = createConfig({
  http: {
    listen: 8000, // port, UNIX socket or options
  },
  cors: true,
  logger: { level: "debug", color: true },
});

(function () {
  const jsonOpenApiSpec = new Documentation({
    routing, // the same routing and config that you use to start the server
    config,
    version: "1.2.3",
    title: "Coltivio API",
    serverUrl: "http://localhost:8000",
    composition: "components", // optional, or "components" for keeping schemas in a separate dedicated section using refs

    // descriptions: { positiveResponse, negativeResponse, requestParameter, requestBody } // check out these features
  }).getSpecAsJson();
  writeFileSync("./openapi.json", jsonOpenApiSpec);
})();
