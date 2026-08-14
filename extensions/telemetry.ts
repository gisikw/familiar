import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "fs";

export default function (pi: ExtensionAPI) {
  const telemetryPath = process.env.FAMILIAR_LOG_PATH;
  if (!telemetryPath) return;
  pi.on("message_end", async ({ type, ...event }, ctx) => {
    fs.appendFile(telemetryPath, JSON.stringify(event) + "\n", 'utf8', err => {
      if (err) {
        console.log(err);
      }
    });
  });
}
