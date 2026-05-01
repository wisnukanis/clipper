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
  range: argValue("--range", "")
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
