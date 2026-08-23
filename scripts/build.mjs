// build.mjs

import { spawn } from "node:child_process";

const run = (command, args = []) =>
    new Promise((replace, reject) => {
        const child = spawn(command, args, {
            shell: true,
            stdio: "inherit",
        });

        child.on("error", reject);

        child.on("exit", code => {
            if (code === 0) replace();
            else reject(new Error(`${command} exited with code ${code}`));
        });
    });

try {
    console.log("[git] Fetching latest...");
    await run("git", ["fetch", "origin"]);

    console.log("[git] Resetting to origin/master...");
    await run("git", ["reset", "--hard", "origin/master"]);

    console.log("[install] npm install...");
    await run("npm", ["install"]);

    console.log("[start] npm run agent");
    await run("npm", ["run", "agent"]);
} catch (err) {
    console.error("[error]", err.message);
    process.exit(1);
}
