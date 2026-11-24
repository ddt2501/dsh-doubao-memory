// setup_snapshot_cron.js — Node script to create snapshot bootstrap cron
// (PowerShell 调 openclaw --command-argv 时 JSON 转义有问题, 用 Node + shell:true 绕开)
const { execSync } = require("child_process");

const argvJson = '["python","D:\\\\openclaw\\\\workspace\\\\manas-system\\\\snapshot_to_bootstrap.py"]';

const args = [
  "automations", "add",
  "--name", "manas-snapshot-bootstrap",
  "--display-name", "manas 住相 bootstrap",
  "--cron", "30 5 * * *",
  "--tz", "Asia/Shanghai",
  "--session", "isolated",
  "--command-cwd", "D:\\openclaw\\workspace\\manas-system",
  "--command-argv", argvJson,
  "--timeout-seconds", "120",
  "--no-deliver"
];

// Escape for Windows cmd shell
const escaped = args.map(a => {
  if (/[\s"&|<>^]/.test(a)) return `"${a.replace(/"/g, '\\"')}"`;
  return a;
});

const cmd = "openclaw " + escaped.join(" ");
console.log("CMD:", cmd);

try {
  const out = execSync(cmd, { encoding: "utf-8", shell: true });
  console.log("OK:", out);
} catch (e) {
  console.log("ERR:", e.stderr || e.stdout || e.message);
  process.exit(1);
}