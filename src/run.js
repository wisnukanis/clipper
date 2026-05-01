import { config } from "./config.js";
import { runWorkflow } from "./workflow.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

const options = {
  publish: hasArg("--publish"),
  scheduled: hasArg("--scheduled"),
  theme: argValue("--theme", process.env.THEME || config.defaultTheme),
  url: argValue("--url", ""),
  range: argValue("--range", ""),
  qualityProfile: argValue("--quality", process.env.VIDEO_QUALITY_PROFILE || "standard"),
  subtitleFont: argValue("--subtitle-font", process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold"),
  subtitleFontSize: Number(argValue("--subtitle-font-size", process.env.SUBTITLE_FONT_SIZE || "48")),
  subtitleMarginV: Number(argValue("--subtitle-margin-v", process.env.SUBTITLE_MARGIN_V || "270")),
  forceReprocess: hasArg("--force-reprocess")
};

if (hasArg("--dry-run")) {
  options.publish = false;
}

runWorkflow(options)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
