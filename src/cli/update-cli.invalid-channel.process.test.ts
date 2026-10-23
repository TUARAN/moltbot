import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

it.each([
  ...["repair", "finalize"].flatMap((command) =>
    ["parent", "leaf", "human"].flatMap((format) =>
      ["", "unrecognized-channel", 'beta"\nFORGED\u001b[31m'].map((channel) => ({
        command,
        target: command,
        format,
        channel,
        channelLabel: JSON.stringify(channel),
      })),
    ),
  ),
  ...["parent", "human"].flatMap((format) =>
    ["", "unrecognized-channel", 'beta"\nFORGED\u001b[31m'].map((channel) => ({
      command: undefined,
      target: "update",
      format,
      channel,
      channelLabel: JSON.stringify(channel),
    })),
  ),
])(
  "reports invalid $target channel $channelLabel in $format output",
  async ({ command, format, channel }) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      await state.writeConfig({ update: { channel: "stable" } });
      const before = await fs.readFile(state.configPath, "utf8");
      const result = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          "update",
          ...(format === "parent" ? ["--json"] : []),
          ...(command ? [command] : []),
          "--channel",
          channel,
          ...(format === "leaf" ? ["--json"] : []),
        ],
        env: { ...process.env, ...state.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
      });
      const message = `--channel must be "stable", "extended-stable", "beta", or "dev" (got ${JSON.stringify(channel)})`;
      expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
      // Top-level parent JSON errors cross run-main's stable diagnostic frame;
      // repair/finalize JSON and human output leave the bare validation reason on stderr.
      const expectedStderr =
        command === undefined && format === "parent"
          ? [
              "[openclaw] The CLI command failed.",
              `[openclaw] Reason: ${message}`,
              "[openclaw] For help, run `openclaw doctor`.",
            ].join("\n")
          : message;
      expect(result.stderr.trim()).toBe(expectedStderr);
      if (format === "human") {
        expect(result.stdout).toBe("");
      } else {
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: { type: "cli_error", message },
        });
      }
      expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
    });
  },
);
