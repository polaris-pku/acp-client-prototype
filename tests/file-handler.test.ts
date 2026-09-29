import dotenv from "dotenv";
dotenv.config();

import { AcpClientBuilder, ADAPTER_REGISTRY } from "../src/index.js";
import { RequestError } from "@agentclientprotocol/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function printUsage(): void {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           Filesystem Handler Integration Test Runner         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log("Usage:");
  console.log("  node dist/tests/file-handler.test.js [agent-id]");
  console.log();
  console.log("Note:");
  console.log("  If no [agent-id] is provided, it defaults to 'mock-driver'.");
  console.log();
  console.log("Available agents:");
  for (const adapter of ADAPTER_REGISTRY.listAdapters()) {
    console.log(`  - ${adapter.agentId.padEnd(12)} (${adapter.name}) [${adapter.connectionType}]`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  // Default to mock-driver if no agentId parameter is provided
  const agentId = args[0] || "mock-driver";
  const verbose =
    process.env.VERBOSE === "1" ||
    process.argv.includes("--verbose") ||
    process.argv.includes("-v");

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        Filesystem Handler Integration Test (Read/Write)      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`Agent: ${agentId}`);
  console.log();

  const tempDir = path.join(process.cwd(), ".temp");
  await fs.mkdir(tempDir, { recursive: true });

  const writeTestFile = path.join(".temp", "test-write.txt");
  const readTestFile = path.join(".temp", "test-read.txt");

  const writeExpectedContent = "Filesystem write verification token: XYZ123";
  const readSecretContent = "Secret Token: ABC789";

  // Pre-clean files if they exist
  try {
    await fs.unlink(path.resolve(process.cwd(), writeTestFile));
  } catch {
    /* ignore */
  }
  try {
    await fs.unlink(path.resolve(process.cwd(), readTestFile));
  } catch {
    /* ignore */
  }

  // 1. Build Client
  const builder = new AcpClientBuilder()
    .withAgent(agentId)
    .withVerbose(verbose)
    .withAutoApprove(true)
    .withSandboxDir(process.cwd());

  const client = builder.build();

  // Setup streaming response accumulator
  let responseText = "";
  client.on("agent_message_chunk", (payload) => {
    const text = payload.update.content.text;
    responseText += text;
    process.stdout.write(text);
  });

  try {
    console.log("[1/5] Initializing Client...");
    await client.initialize();
    await client.authenticate();
    const session = await client.createSession(process.cwd());
    console.log(`      ✓ Session started: ${session.sessionId}`);

    // --- TEST 1: FILESYSTEM WRITE ---
    console.log("\n[2/5] Testing Filesystem Write Capability...");
    const writePrompt = `Please use your filesystem write capability to create a text file at '${writeTestFile}' containing exactly: '${writeExpectedContent}'. Do not output anything else.`;
    console.log(`Prompt: "${writePrompt}"`);
    console.log("══════════════════════════════════════════════════════════════");

    const writeTurn = await client.sendPrompt(writePrompt);
    const writeResult = await writeTurn.result;

    console.log();
    console.log("══════════════════════════════════════════════════════════════");
    console.log(`Write turn complete. Stop reason: ${writeResult?.stopReason || "done"}`);

    // Verify written file
    console.log("\nVerifying output file...");
    const actualWriteContent = await fs.readFile(
      path.resolve(process.cwd(), writeTestFile),
      "utf-8"
    );
    if (!actualWriteContent.includes(writeExpectedContent)) {
      throw new Error(
        `File write verification failed. Expected content to contain "${writeExpectedContent}", but got:\n${actualWriteContent}`
      );
    }
    console.log(`      ✓ File exists: ${writeTestFile}`);
    console.log(`      ✓ Content verified: ${actualWriteContent.trim()}`);

    // --- TEST 2: FILESYSTEM READ ---
    console.log("\n[3/5] Testing Filesystem Read Capability...");
    console.log(`Pre-creating file ${readTestFile} with secret token...`);
    await fs.writeFile(path.resolve(process.cwd(), readTestFile), readSecretContent, "utf-8");

    // Reset accumulator
    responseText = "";

    const readPrompt = `Please use your filesystem read capability to read the file at '${readTestFile}', find the secret token inside it, and output that secret token.`;
    console.log(`Prompt: "${readPrompt}"`);
    console.log("══════════════════════════════════════════════════════════════");

    const readTurn = await client.sendPrompt(readPrompt);
    const readResult = await readTurn.result;

    console.log();
    console.log("══════════════════════════════════════════════════════════════");
    console.log(`Read turn complete. Stop reason: ${readResult?.stopReason || "done"}`);

    // Verify read output
    console.log("\nVerifying read output response...");
    if (!responseText.includes("ABC789")) {
      throw new Error(
        `File read verification failed. Agent response did not contain the secret token "ABC789". Agent response was:\n${responseText}`
      );
    }
    console.log(`      ✓ Agent successfully read the file and found the token!`);

    // --- TEST 3: SECURITY OUT OF BOUNDS PROTECTION ---
    console.log("\n[4/5] Testing Filesystem Directory Safety Boundaries...");
    // Let's attempt to read a file outside the base sandbox directory (e.g., "../package.json")
    // The FileSystemHandler should block this with an ACP-visible JSON-RPC error.
    const methodRouter = (client as any).methodRouter;
    if (methodRouter) {
      console.log("Verifying read safety directly on method router...");
      try {
        await methodRouter.route("fs/read_text_file", { path: "../package.json" });
        throw new Error("FAIL: Directory traversal read was not blocked!");
      } catch (err) {
        if (isPermissionDeniedRequestError(err)) {
          console.log(`      ✓ Direct read traversal correctly blocked: ${err.message}`);
        } else {
          throw err;
        }
      }

      console.log("Verifying write safety directly on method router...");
      try {
        await methodRouter.route("fs/write_text_file", {
          path: "../evil.txt",
          content: "evil",
        });
        throw new Error("FAIL: Directory traversal write was not blocked!");
      } catch (err) {
        if (isPermissionDeniedRequestError(err)) {
          console.log(`      ✓ Direct write traversal correctly blocked: ${err.message}`);
        } else {
          throw err;
        }
      }
    }

    // --- CLEANUP ---
    console.log("\n[5/5] Cleaning up temporary files...");
    try {
      await fs.unlink(path.resolve(process.cwd(), writeTestFile));
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(path.resolve(process.cwd(), readTestFile));
    } catch {
      /* ignore */
    }
    console.log("      ✓ Cleaned up test files.");

    console.log("\n==================================================");
    console.log("All filesystem tests PASSED successfully!");
    console.log("==================================================");
  } catch (error) {
    console.error("\n[Test:Error]:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    // Clean up in case of failure
    try {
      await fs.unlink(path.resolve(process.cwd(), writeTestFile));
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(path.resolve(process.cwd(), readTestFile));
    } catch {
      /* ignore */
    }
    await client.shutdown();
  }
}

function isPermissionDeniedRequestError(err: unknown): err is RequestError {
  return (
    err instanceof RequestError && err.code === -32003 && err.message.includes("Access denied")
  );
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
