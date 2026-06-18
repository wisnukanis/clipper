import subprocess
import sys


def main():
    args = sys.argv[1:]
    node_args = ["node", "src/run.js"]

    mode = ""
    dry_run = False
    converted = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--mode" and index + 1 < len(args):
          mode = args[index + 1]
          index += 2
          continue
        if arg == "--dry-run":
          dry_run = True
        converted.append(arg)
        index += 1

    if mode == "dry-run":
        converted = ["--mode", "discover", "--dry-run"] + converted
    elif mode == "render-test":
        converted = ["--mode", "render", "--dry-run"] + converted
    elif mode == "upload-pending":
        converted = ["--mode", "upload-pending"] + converted
    elif mode:
        converted = ["--mode", mode] + converted

    if dry_run and "--dry-run" not in converted:
        converted.append("--dry-run")

    raise SystemExit(subprocess.call(node_args + converted))


if __name__ == "__main__":
    main()
