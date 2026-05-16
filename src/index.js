#!/usr/bin/env node

import {
  getListeningPorts,
  getPortDetails,
  findOrphanedProcesses,
  killProcess,
  watchPorts,
  isDevProcess,
  getAllProcesses,
  resolveKillTarget,
  getProcessLogFiles,
  getSystemLogCommand,
} from "./scanner.js";
import {
  displayPortTable,
  displayPortDetail,
  displayCleanResults,
  displayWatchEvent,
  displayWatchHeader,
  displayProcessTable,
} from "./display.js";
import chalk from "chalk";
import { createInterface } from "readline";
import { spawn } from "child_process";

function spawnTail(filePath, numLines, follow = true) {
  if (process.platform === "win32") {
    const waitFlag = follow ? " -Wait" : "";
    return spawn("powershell", [
      "-Command",
      `Get-Content -Path '${filePath}' -Tail ${numLines}${waitFlag}`,
    ], { stdio: "inherit" });
  }
  const args = follow ? ["-f", "-n", numLines, filePath] : ["-n", numLines, filePath];
  return spawn("tail", args, { stdio: "inherit" });
}

const args = process.argv.slice(2);
const showAll = args.includes("--all") || args.includes("-a");
const filteredArgs = args.filter((a) => a !== "--all" && a !== "-a");
const command = filteredArgs[0];

async function main() {
  // No args: show dev ports by default, --all for everything
  if (!command) {
    let ports = await getListeningPorts();
    if (!showAll) {
      ports = ports.filter((p) => isDevProcess(p.processName, p.command));
    }
    displayPortTable(ports, !showAll);
    return;
  }

  // Specific port number
  const portNum = parseInt(command, 10);
  if (!isNaN(portNum)) {
    const info = await getPortDetails(portNum);
    displayPortDetail(info);

    if (info) {
      // Interactive kill prompt
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(
        chalk.yellow(`  Kill process on :${portNum}? [y/N] `),
        (answer) => {
          if (answer.toLowerCase() === "y") {
            const success = killProcess(info.pid);
            if (success) {
              console.log(chalk.green(`\n  ✓ Killed PID ${info.pid}\n`));
            } else {
              console.log(
                chalk.red(`\n  ✕ Failed. Try: sudo kill -9 ${info.pid}\n`),
              );
            }
          }
          rl.close();
        },
      );
    }
    return;
  }

  // Named commands
  switch (command) {
    case "ps": {
      let processes = await getAllProcesses();
      if (!showAll) {
        processes = processes.filter((p) =>
          isDevProcess(p.processName, p.command),
        );
        // Collapse Docker internal processes into one summary row
        const dockerProcs = processes.filter(
          (p) =>
            p.processName.startsWith("com.docke") ||
            p.processName.startsWith("Docker") ||
            p.processName === "docker" ||
            p.processName === "docker-sandbox",
        );
        const nonDocker = processes.filter(
          (p) =>
            !p.processName.startsWith("com.docke") &&
            !p.processName.startsWith("Docker") &&
            p.processName !== "docker" &&
            p.processName !== "docker-sandbox",
        );
        if (dockerProcs.length > 0) {
          const totalCpu = dockerProcs.reduce((s, p) => s + p.cpu, 0);
          const totalRssKB = dockerProcs.reduce((s, p) => {
            const m = (p.memory || "").match(/([\d.]+)\s*(GB|MB|KB)/);
            if (!m) return s;
            const val = parseFloat(m[1]);
            if (m[2] === "GB") return s + val * 1048576;
            if (m[2] === "MB") return s + val * 1024;
            return s + val;
          }, 0);
          const memStr =
            totalRssKB > 1048576
              ? `${(totalRssKB / 1048576).toFixed(1)} GB`
              : totalRssKB > 1024
                ? `${(totalRssKB / 1024).toFixed(1)} MB`
                : `${Math.round(totalRssKB)} KB`;
          nonDocker.push({
            pid: dockerProcs[0].pid,
            processName: "Docker",
            command: "",
            description: `${dockerProcs.length} processes`,
            cpu: totalCpu,
            memory: memStr,
            cwd: null,
            projectName: null,
            framework: "Docker",
            uptime: dockerProcs[0].uptime,
          });
        }
        processes = nonDocker;
      }
      processes.sort((a, b) => b.cpu - a.cpu);
      displayProcessTable(processes, !showAll);
      break;
    }

    case "clean": {
      const orphaned = await findOrphanedProcesses();
      const killed = [];
      const failed = [];

      if (orphaned.length === 0) {
        displayCleanResults(orphaned, killed, failed);
        return;
      }

      // Confirm before killing
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log();
      console.log(
        chalk.yellow.bold(
          `  Found ${orphaned.length} orphaned/zombie process${orphaned.length === 1 ? "" : "es"}:`,
        ),
      );
      for (const p of orphaned) {
        console.log(
          `  ${chalk.gray("•")} :${chalk.white.bold(p.port)} — ${p.processName} ${chalk.gray(`(PID ${p.pid})`)}`,
        );
      }
      console.log();

      rl.question(chalk.yellow("  Kill all? [y/N] "), (answer) => {
        if (answer.toLowerCase() === "y") {
          for (const p of orphaned) {
            if (killProcess(p.pid)) {
              killed.push(p.pid);
            } else {
              failed.push(p.pid);
            }
          }
          displayCleanResults(orphaned, killed, failed);
        } else {
          console.log(chalk.gray("\n  Aborted.\n"));
        }
        rl.close();
      });
      break;
    }

    case "kill": {
      const force =
        filteredArgs.includes("--force") || filteredArgs.includes("-f");
      const skipConfirm =
        filteredArgs.includes("--yes") || filteredArgs.includes("-y");
      const signal = force ? "SIGKILL" : "SIGTERM";
      const rawKillArgs = filteredArgs
        .slice(1)
        .filter(
          (a) =>
            a !== "--force" &&
            a !== "-f" &&
            a !== "--yes" &&
            a !== "-y",
        );

      if (rawKillArgs.length === 0) {
        console.log(
          chalk.red(
            `\n  Usage: ports kill [-f|--force] [-y|--yes] <port|pid|range|name> [...]\n`,
          ),
        );
        console.log(
          chalk.gray(
            "  Kills listener on port (1-65535), process by PID, or all listeners matching a process name.",
          ),
        );
        console.log(chalk.gray("  Ranges: ports kill 3000-3010"));
        console.log(chalk.gray("  Names:  ports kill node bun  (case-insensitive, matches listening processes)"));
        console.log(chalk.gray("  Flags:  -f SIGKILL, -y skip confirmation\n"));
        process.exit(1);
      }

      // Build target list. Each entry: { pid, label, source: 'port'|'pid'|'name'|'range', name? }
      const targets = [];
      const seenPids = new Set();
      let anyFailed = false;
      let listenersCache = null;
      const getListeners = async () => {
        if (!listenersCache) listenersCache = await getListeningPorts();
        return listenersCache;
      };

      const addTarget = (t) => {
        if (seenPids.has(t.pid)) return;
        seenPids.add(t.pid);
        targets.push(t);
      };

      let rangeMissCount = 0;
      let rangeUsed = false;

      for (const arg of rawKillArgs) {
        const rangeMatch = arg.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          rangeUsed = true;
          const start = parseInt(rangeMatch[1], 10);
          const end = parseInt(rangeMatch[2], 10);
          if (start > end) {
            console.log(chalk.red(`\n  ✕ Invalid range: ${arg} (start must be less than end)\n`));
            process.exitCode = 1;
            return;
          }
          if (end - start > 1000) {
            console.log(chalk.red(`\n  ✕ Range too large: ${arg} (max 1000 ports)\n`));
            process.exitCode = 1;
            return;
          }
          if (start < 1 || end > 65535) {
            console.log(chalk.red(`\n  ✕ Invalid range: ${arg} (ports must be 1-65535)\n`));
            process.exitCode = 1;
            return;
          }
          for (let p = start; p <= end; p++) {
            const resolved = await resolveKillTarget(p);
            if (!resolved) {
              rangeMissCount++;
              continue;
            }
            addTarget({
              pid: resolved.pid,
              label: `:${resolved.port} — ${resolved.info?.processName || "unknown"} (PID ${resolved.pid})`,
              source: "range",
            });
          }
          continue;
        }

        const n = parseInt(arg, 10);
        const isNumeric = !isNaN(n) && String(n) === arg.trim();

        if (isNumeric) {
          const resolved = await resolveKillTarget(n);
          if (!resolved) {
            const msg =
              n <= 65535
                ? `No listener on :${n} and no process with PID ${n}`
                : `No process with PID ${n}`;
            console.log(chalk.red(`  ✕ ${msg}`));
            anyFailed = true;
            continue;
          }
          const label =
            resolved.via === "port"
              ? `:${resolved.port} — ${resolved.info?.processName || "unknown"} (PID ${resolved.pid})`
              : `PID ${resolved.pid}`;
          addTarget({ pid: resolved.pid, label, source: resolved.via });
          continue;
        }

        // Name match against listening ports (case-insensitive exact on processName)
        const nameLc = arg.toLowerCase();
        const listeners = await getListeners();
        const matches = listeners.filter(
          (p) => (p.processName || "").toLowerCase() === nameLc,
        );
        if (matches.length === 0) {
          console.log(chalk.red(`  ✕ No listening process named "${arg}"`));
          anyFailed = true;
          continue;
        }
        for (const m of matches) {
          addTarget({
            pid: m.pid,
            label: `:${m.port} — ${m.processName} (PID ${m.pid})`,
            source: "name",
            name: arg,
          });
        }
      }

      if (targets.length === 0) {
        if (rangeUsed && rangeMissCount > 0) {
          console.log(chalk.gray(`  ${rangeMissCount} empty port(s) in range, nothing to kill.\n`));
        }
        process.exitCode = anyFailed ? 1 : 0;
        break;
      }

      // Confirm when more than one target, unless -y, or when any name match selected multiple
      const nameMatchCount = targets.filter((t) => t.source === "name").length;
      const needConfirm =
        !skipConfirm && (targets.length > 1 || nameMatchCount > 0);

      if (needConfirm) {
        console.log();
        console.log(
          chalk.yellow.bold(
            `  About to kill ${targets.length} process${targets.length === 1 ? "" : "es"} (${signal}):`,
          ),
        );
        for (const t of targets) {
          console.log(`  ${chalk.gray("•")} ${t.label}`);
        }
        console.log();

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((resolve) => {
          rl.question(chalk.yellow("  Proceed? [Y/n] "), resolve);
        });
        rl.close();
        const a = answer.trim().toLowerCase();
        if (a === "n" || a === "no") {
          console.log(chalk.gray("\n  Aborted.\n"));
          process.exitCode = 0;
          break;
        }
      }

      let killed = 0;
      console.log();
      for (const t of targets) {
        const ok = killProcess(t.pid, signal);
        if (ok) {
          console.log(chalk.green(`  ✓ Sent ${signal} to ${t.label}`));
          killed++;
        } else {
          console.log(
            chalk.red(`  ✕ Failed: ${t.label}. Try: sudo kill${force ? " -9" : ""} ${t.pid}`),
          );
          anyFailed = true;
        }
      }

      if (rangeUsed || targets.length > 1) {
        const parts = [];
        if (killed > 0) parts.push(chalk.green(`${killed} killed`));
        if (rangeMissCount > 0) parts.push(chalk.gray(`${rangeMissCount} empty`));
        if (anyFailed) parts.push(chalk.red("some failed"));
        if (parts.length > 0) {
          console.log(`  ${chalk.dim("Summary:")} ${parts.join(chalk.dim(", "))}`);
        }
      }

      console.log();
      process.exitCode = anyFailed ? 1 : 0;
      break;
    }

    case "logs": {
      const follow = filteredArgs.includes("-f") || filteredArgs.includes("--follow");
      const errOnly = filteredArgs.includes("--err");
      // Parse --lines=N or --lines N
      let lines = "50";
      const linesEqArg = filteredArgs.find((a) => a.startsWith("--lines="));
      if (linesEqArg) {
        lines = linesEqArg.split("=")[1];
      } else {
        const linesIdx = filteredArgs.indexOf("--lines");
        if (linesIdx !== -1 && filteredArgs[linesIdx + 1]) {
          lines = filteredArgs[linesIdx + 1];
        }
      }
      const logsArgs = filteredArgs
        .slice(1)
        .filter((a) => !a.startsWith("--") && a !== "-f" && a !== lines);

      if (logsArgs.length === 0) {
        console.log(
          chalk.red(
            `\n  Usage: ports logs <port|pid> [-f] [--lines=N] [--err]\n`,
          ),
        );
        console.log(chalk.gray("  Show log output for a process running on a port."));
        console.log(chalk.gray("  Use -f or --follow to stream new lines.\n"));
        process.exit(1);
      }

      const target = parseInt(logsArgs[0], 10);
      if (isNaN(target)) {
        console.log(chalk.red(`\n  ✕ "${logsArgs[0]}" is not a valid port/PID\n`));
        process.exit(1);
      }

      const resolved = await resolveKillTarget(target);
      if (!resolved) {
        const msg =
          target <= 65535
            ? `No listener on :${target} and no process with PID ${target}`
            : `No process with PID ${target}`;
        console.log(chalk.red(`\n  ✕ ${msg}\n`));
        process.exit(1);
      }

      const { pid, via } = resolved;
      const portLabel = via === "port" ? `:${resolved.port}` : `PID ${pid}`;
      const processName = resolved.info?.processName || "unknown";

      console.log();
      console.log(
        chalk.cyan.bold("  @ropean/ports") +
          chalk.gray(` — logs for ${portLabel} (${processName}, PID ${pid})`),
      );
      console.log();

      const logFiles = getProcessLogFiles(pid);

      if (errOnly) {
        const stderrFile = logFiles.find((f) => f.fd === "stderr");
        if (stderrFile) {
          console.log(
            `  ${chalk.yellow("▸")} Tailing stderr: ${chalk.dim(stderrFile.path)}\n`,
          );
          const tail = spawnTail(stderrFile.path, lines, follow);
          if (follow) {
            process.on("SIGINT", () => { tail.kill(); process.exit(0); });
            await new Promise(() => {});
          } else {
            await new Promise((resolve) => tail.on("close", resolve));
          }
          break;
        }
        console.log(chalk.yellow(`  No stderr redirect found for PID ${pid}\n`));
        break;
      }

      if (logFiles.length > 0) {
        if (logFiles.length === 1) {
          const f = logFiles[0];
          const label = f.fd === "stdout" ? "stdout" : f.fd === "stderr" ? "stderr" : "log";
          console.log(
            `  ${chalk.green("▸")} Tailing ${label}: ${chalk.dim(f.path)}\n`,
          );
          const tail = spawnTail(f.path, lines, follow);
          if (follow) {
            process.on("SIGINT", () => { tail.kill(); process.exit(0); });
            await new Promise(() => {});
          } else {
            await new Promise((resolve) => tail.on("close", resolve));
          }
          break;
        }

        // Multiple log files — let user pick
        console.log(chalk.bold("  Found log files:\n"));
        logFiles.forEach((f, i) => {
          const label =
            f.fd === "stdout" ? chalk.green("stdout") :
            f.fd === "stderr" ? chalk.yellow("stderr") :
            chalk.dim(f.type);
          console.log(`    ${chalk.white.bold(i + 1)}  ${label}  ${chalk.dim(f.path)}`);
        });
        console.log();

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((resolve) => {
          rl.question(chalk.yellow(`  Pick a file (1-${logFiles.length}): `), resolve);
        });
        rl.close();

        const idx = parseInt(answer, 10) - 1;
        if (idx < 0 || idx >= logFiles.length) {
          console.log(chalk.red("\n  Invalid selection.\n"));
          break;
        }

        const selected = logFiles[idx];
        console.log(
          `\n  ${chalk.green("▸")} Tailing: ${chalk.dim(selected.path)}\n`,
        );
        const tail = spawnTail(selected.path, lines, follow);
        if (follow) {
          process.on("SIGINT", () => { tail.kill(); process.exit(0); });
          await new Promise(() => {});
        } else {
          await new Promise((resolve) => tail.on("close", resolve));
        }
      }

      // No log files — try system log
      const sysCmd = getSystemLogCommand(pid, follow);
      if (sysCmd) {
        console.log(
          chalk.yellow(`  No log files found. Falling back to system log...\n`),
        );
        console.log(`  ${chalk.dim(`$ ${sysCmd}`)}\n`);
        const [cmd, ...sysArgs] = sysCmd.split(" ");
        const proc = spawn(cmd, sysArgs, { stdio: "inherit" });
        if (follow) {
          process.on("SIGINT", () => { proc.kill(); process.exit(0); });
          await new Promise(() => {});
        } else {
          await new Promise((resolve) => proc.on("close", resolve));
        }
      }

      console.log(
        chalk.yellow(`  No log files or system log found for PID ${pid}.\n`),
      );
      console.log(
        chalk.dim(
          `  Tip: if the process logs to the terminal, check the terminal where it was started.\n`,
        ),
      );
      break;
    }

    case "watch": {
      displayWatchHeader();
      const interval = watchPorts((type, info) => {
        displayWatchEvent(type, info);
      }, 2000);

      // Handle graceful exit
      process.on("SIGINT", () => {
        clearInterval(interval);
        console.log(chalk.gray("\n\n  Stopped watching.\n"));
        process.exit(0);
      });
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      console.log();
      console.log(
        chalk.cyan.bold("  @ropean/ports") +
          chalk.gray(" — listen to your ports"),
      );
      console.log();
      console.log(chalk.white("  Usage:"));
      const helpRows = [
        ["ports", "Show dev server ports"],
        ["ports --all", "Show all listening ports"],
        ["ports ps", "Show all running dev processes"],
        ["ports <number>", "Detailed info about a specific port"],
        ["ports kill <n>", "Kill by port, PID, range, or name (-f SIGKILL, -y skip prompt)"],
        ["ports kill 3000-3010", "Kill all listeners in a port range"],
        ["ports kill node bun", "Kill all listening processes matching a name"],
        ["ports logs <n>", "Tail log output for a process on a port"],
        ["ports clean", "Kill orphaned/zombie dev servers"],
        ["ports watch", "Monitor port changes in real-time"],
      ];
      const cmdWidth = Math.max(...helpRows.map((r) => r[0].length));
      for (const [cmd, desc] of helpRows) {
        const padded = cmd + " ".repeat(cmdWidth - cmd.length);
        console.log(`    ${chalk.cyan(padded)}  ${desc}`);
      }
      console.log();
      break;
    }

    default:
      console.log(chalk.red(`\n  Unknown command: ${command}`));
      console.log(
        chalk.gray(`  Run ${chalk.cyan("ports --help")} for usage.\n`),
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red(`\n  Error: ${err.message}\n`));
  process.exit(1);
});
