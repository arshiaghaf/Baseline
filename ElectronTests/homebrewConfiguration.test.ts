// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkHomebrewConfiguration,
  safeConfigurationReason
} from "../src/main/homebrewConfiguration";

it("allows only fixed diagnostic fields and redacts every home path", () => {
  expect(
    safeConfigurationReason({
      kind: "invalid-assignment",
      file: "/Users/alice/.homebrew/brew.env",
      line: 999999,
      setting: "SECRET_NAME",
      value: "secret",
      exception: "private text"
    })
  ).toEqual({
    kind: "invalid-assignment",
    file: "~/.homebrew/brew.env",
    path: undefined,
    line: undefined,
    setting: undefined
  });
  expect(
    safeConfigurationReason({
      kind: "invalid-executable",
      path: "/Users/alice/homebrew/bin/brew",
      file: "/Users/alice/brew.env"
    }).path
  ).toBe("~/homebrew/bin/brew");
  expect(
    safeConfigurationReason({ kind: "invalid-setting-path", setting: "ARBITRARY" }).setting
  ).toBeUndefined();
});

// The unmodified launcher always reads the host system configuration. Avoid
// making fixture assertions about a developer's unrelated global settings.
describe.skipIf(existsSync("/etc/homebrew/brew.env"))(
  "literal Homebrew configuration support",
  () => {
    let directory: string, executable: string, prefixFile: string, userFile: string;
    let env: NodeJS.ProcessEnv;
    beforeEach(async () => {
      directory = await mkdtemp("/tmp/baseline brew config ");
      executable = path.join(directory, "prefix/bin/brew");
      prefixFile = path.join(directory, "prefix/etc/homebrew/brew.env");
      userFile = path.join(directory, "user/.homebrew/brew.env");
      for (const file of [executable, prefixFile, userFile])
        await mkdir(path.dirname(file), { recursive: true });
      await copyFile("ElectronTests/Fixtures/Homebrew/brew", executable);
      await chmod(executable, 0o755);
      env = { HOME: path.join(directory, "user"), USER: "fixture", PWD: directory };
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("preserves unrelated literal settings and detects replacement after preflight", async () => {
      await writeFile(
        prefixFile,
        " # ignored\n  HOMEBREW_NO_ANALYTICS=1 \t\nhttps_proxy=https://fixture.invalid\nHOMEBREW_EDITOR='literal $value'\n"
      );
      const check = await checkHomebrewConfiguration(executable, env);
      expect(check.supported).toBe(true);
      if (!check.supported) return;
      expect(await check.revalidate()).toBe(true);
      await writeFile(prefixFile, "HOMEBREW_NO_ANALYTICS=0\n");
      expect(await check.revalidate()).toBe(false);
      expect(await check.revalidateDetailed()).toEqual({
        valid: false,
        detail: { kind: "changed", file: await realpath(prefixFile) }
      });
    });

    it.each([
      "SUDO_ASKPASS=/fixture/helper\n",
      " \tSUDO_ASKPASS= \t\n",
      "HOMEBREW_BASELINE_ASKPASS_SOCKET=/fixture/status\n",
      "HOMEBREW_BASELINE_ASKPASS_OPERATION=fixture\n"
    ])(
      "refuses accepted askpass or reserved assignment without exposing its value: %j",
      async (content) => {
        await writeFile(userFile, content);
        expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
          supported: false,
          reason: "conflict"
        });
      }
    );

    it("ignores the final unterminated record exactly like read -r", async () => {
      await writeFile(prefixFile, "HOMEBREW_NO_ANALYTICS=1\nSUDO_ASKPASS=/ignored");
      expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(true);
    });

    it.each([" ", "\t", " \t", "\t "])(
      "matches default-IFS trimming when a redirect ends in %j",
      async (suffix) => {
        const redirected = path.join(directory, "redirected");
        const spacedConfig = path.join(`${redirected}${suffix}`, "homebrew/brew.env");
        await mkdir(path.dirname(spacedConfig), { recursive: true });
        await writeFile(spacedConfig, "SUDO_ASKPASS=/fixture-conflict\n");
        await writeFile(prefixFile, `HOMEBREW_XDG_CONFIG_HOME=${redirected}${suffix}\n`);
        const terminal = path.join(directory, "prefix/Library/Homebrew/brew.sh");
        await mkdir(path.dirname(terminal), { recursive: true });
        await writeFile(
          terminal,
          '#!/bin/bash\n[[ "$HOMEBREW_XDG_CONFIG_HOME" == "$HOMEBREW_FIXTURE_REDIRECT" && -z "${SUDO_ASKPASS+x}" ]]\n'
        );
        const child = spawnSync(executable, ["--version"], {
          env: { ...env, HOMEBREW_FIXTURE_REDIRECT: redirected },
          encoding: "utf8",
          timeout: 2000
        });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stdout).toBe("");
        expect(child.stderr).toBe("");
        expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(true);
      }
    );

    it("finds user configuration redirected by prefix configuration, with inherited XDG precedence", async () => {
      const redirected = path.join(directory, "redirected");
      const config = path.join(redirected, "homebrew/brew.env");
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, "SUDO_ASKPASS=/fixture\n");
      await writeFile(prefixFile, `HOMEBREW_XDG_CONFIG_HOME=${redirected}\n`);
      expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(false);
      const terminal = path.join(directory, "prefix/Library/Homebrew/brew.sh");
      await mkdir(path.dirname(terminal), { recursive: true });
      await writeFile(terminal, '#!/bin/bash\n[[ "$SUDO_ASKPASS" == /fixture ]]\n');
      const child = spawnSync(executable, ["--version"], { env, encoding: "utf8", timeout: 2000 });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe("");
      env.XDG_CONFIG_HOME = path.join(directory, "safe");
      expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(true);
    });

    it.each(["HOME", "XDG_CONFIG_HOME", "HOMEBREW_XDG_CONFIG_HOME", "prefix redirect"])(
      "refuses symlink/.. ambiguity in %s before lexical path normalization",
      async (source) => {
        for (const name of ["base", "other/dir", "other/homebrew", "other/.homebrew"])
          await mkdir(path.join(directory, name), { recursive: true });
        await symlink(path.join(directory, "other/dir"), path.join(directory, "base/link"));
        const rawDirectory = `${directory}/base/link/..`;
        const userConfig = path.join(
          directory,
          "other",
          source === "HOME" ? ".homebrew" : "homebrew",
          "brew.env"
        );
        await writeFile(userConfig, "SUDO_ASKPASS=/fixture-conflict\n");
        if (source === "prefix redirect")
          await writeFile(prefixFile, `HOMEBREW_XDG_CONFIG_HOME=${rawDirectory}\n`);
        else env[source] = rawDirectory;
        const terminal = path.join(directory, "prefix/Library/Homebrew/brew.sh");
        await mkdir(path.dirname(terminal), { recursive: true });
        await writeFile(terminal, '#!/bin/bash\n[[ "$SUDO_ASKPASS" == /fixture-conflict ]]\n');
        const child = spawnSync(executable, ["--version"], {
          env,
          encoding: "utf8",
          timeout: 2000
        });
        expect(child.status).toBe(0);
        expect(child.stdout).toBe("");
        expect(child.stderr).toBe("");
        expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
          supported: false,
          reason: "unsupported"
        });
      }
    );

    it("supports ordinary user directory and relative executable symlinks without dot components in inputs", async () => {
      const actualUser = path.join(directory, "actual-user");
      await mkdir(actualUser);
      const userLink = path.join(directory, "user-link");
      await symlink(actualUser, userLink);
      env.HOME = userLink;
      const repository = path.join(directory, "repository/bin/brew");
      await mkdir(path.dirname(repository), { recursive: true });
      await copyFile(executable, repository);
      await rm(executable);
      await symlink("../../repository/bin/brew", executable);
      expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(true);
      expect(
        (await checkHomebrewConfiguration(`${directory}/prefix/../prefix/bin/brew`, env)).supported
      ).toBe(false);
    });

    it.each([
      "HOMEBREW_BROKEN\n",
      "HOMEBREW_BAD-NAME=value\n",
      "HOMEBREW_FOO=x\r\n",
      "HOMEBREW_FOO=x\0\n"
    ])("refuses unsupported bytes or export syntax conservatively: %j", async (content) => {
      await writeFile(prefixFile, content);
      expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
        supported: false,
        reason: "unsupported"
      });
    });

    it.each(["directory", "oversize", "unreadable", "fifo"] as const)(
      "refuses %s configuration without waiting for a FIFO writer",
      async (kind) => {
        if (kind === "directory") await mkdir(prefixFile);
        if (kind === "oversize") await writeFile(prefixFile, Buffer.alloc(65537, 32));
        if (kind === "unreadable") {
          await writeFile(prefixFile, "");
          await chmod(prefixFile, 0);
        }
        if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [prefixFile]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const check = await Promise.race([
            checkHomebrewConfiguration(executable, env),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Configuration read stalled.")), 1000);
            })
          ]);
          expect(check.supported).toBe(false);
        } finally {
          clearTimeout(timer);
          if (kind === "unreadable") await chmod(prefixFile, 0o600);
        }
      }
    );

    it("matches the launcher for ignored UTF-8 and CRLF records", async () => {
      await writeFile(
        prefixFile,
        "# café\r\nUNRELATED=é\r\nHOMEBREW_PREFIX=é\r\nHOMEBREW_EXPERIMENTAL_RUST_FRONTEND=é\r\nHOMEBREW_NO_ANALYTICS=1\n"
      );
      const terminal = path.join(directory, "prefix/Library/Homebrew/brew.sh");
      await mkdir(path.dirname(terminal), { recursive: true });
      await writeFile(terminal, '#!/bin/bash\n[[ "$HOMEBREW_NO_ANALYTICS" == 1 ]]\n');
      const child = spawnSync(executable, ["--version"], { env, encoding: "utf8", timeout: 2000 });
      expect(child.status).toBe(0);
      const check = await checkHomebrewConfiguration(executable, env);
      expect(check.supported).toBe(true);
    });

    it("follows a valid brew.env symlink and detects target replacement", async () => {
      const target = path.join(directory, "first.env");
      const replacement = path.join(directory, "second.env");
      await writeFile(target, "HOMEBREW_NO_ANALYTICS=1\n");
      await writeFile(replacement, "HOMEBREW_NO_ANALYTICS=1\n");
      await symlink(target, prefixFile);
      const terminal = path.join(directory, "prefix/Library/Homebrew/brew.sh");
      await mkdir(path.dirname(terminal), { recursive: true });
      await writeFile(terminal, '#!/bin/bash\n[[ "$HOMEBREW_NO_ANALYTICS" == 1 ]]\n');
      expect(spawnSync(executable, ["--version"], { env, timeout: 2000 }).status).toBe(0);
      const check = await checkHomebrewConfiguration(executable, env);
      expect(check.supported).toBe(true);
      if (!check.supported) return;
      expect(await check.revalidate()).toBe(true);
      await rm(prefixFile);
      await symlink(replacement, prefixFile);
      expect(await check.revalidate()).toBe(false);
      expect(await check.revalidateDetailed()).toEqual({
        valid: false,
        detail: { kind: "changed", file: (await realpath(path.dirname(prefixFile))) + "/brew.env" }
      });
      expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(true);
    });

    it("retains a typed reason and file when a linked target fails reinspection", async () => {
      const target = path.join(directory, "target.env");
      await writeFile(target, "HOMEBREW_NO_ANALYTICS=1\n");
      await symlink(target, prefixFile);
      const check = await checkHomebrewConfiguration(executable, env);
      expect(check.supported).toBe(true);
      if (!check.supported) return;
      await writeFile(target, "HOMEBREW_BAD-NAME=secret\n");
      expect(await check.revalidateDetailed()).toMatchObject({
        valid: false,
        detail: {
          kind: "invalid-assignment",
          file: (await realpath(path.dirname(prefixFile))) + "/brew.env",
          line: 1
        }
      });
      await rm(target);
      expect(await check.revalidateDetailed()).toMatchObject({
        valid: false,
        detail: {
          kind: "invalid-folder",
          file: (await realpath(path.dirname(prefixFile))) + "/brew.env"
        }
      });
    });

    it("rejects dangling links and conflicts in linked targets", async () => {
      const target = path.join(directory, "linked.env");
      await symlink(target, prefixFile);
      expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(false);
      await writeFile(target, "SUDO_ASKPASS=/fixture\n");
      expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
        supported: false,
        reason: "conflict"
      });
    });

    it("rejects a linked directory as a non-regular target", async () => {
      const target = path.join(directory, "directory-target");
      await mkdir(target);
      await symlink(target, prefixFile);
      expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
        supported: false,
        detail: { kind: "non-regular" }
      });
    });

    it.each(["HOMEBREW_FOO=x\r\n", "HOMEBREW_FOO=é\n", "HOMEBREW_BAD-NAME=value\n"])(
      "rejects malformed accepted launcher records: %j",
      async (content) => {
        await writeFile(prefixFile, content);
        expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(false);
      }
    );

    it("reports a bounded line number and a fixed setting name without its value", async () => {
      await writeFile(prefixFile, "# ignored\nHOMEBREW_BAD-NAME=secret\n");
      expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
        supported: false,
        detail: { kind: "invalid-assignment", file: await realpath(prefixFile), line: 2 }
      });
      await writeFile(prefixFile, "HOMEBREW_XDG_CONFIG_HOME=relative/secret\n");
      expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
        supported: false,
        detail: {
          kind: "invalid-setting-path",
          setting: "HOMEBREW_XDG_CONFIG_HOME",
          file: await realpath(prefixFile)
        }
      });
      env.XDG_CONFIG_HOME = "relative/secret";
      expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
        supported: false,
        detail: { kind: "invalid-setting-path", setting: "XDG_CONFIG_HOME", file: undefined }
      });
    });

    it("redacts the brew executable path in a validation failure", async () => {
      expect(await checkHomebrewConfiguration("/Users/private/bin/brew", env)).toMatchObject({
        supported: false,
        detail: { kind: "invalid-executable", path: "~/bin/brew" }
      });
    });

    it("checks the executable launch prefix when bin/brew links into another repository", async () => {
      const repository = path.join(directory, "repository/bin/brew");
      await mkdir(path.dirname(repository), { recursive: true });
      await copyFile(executable, repository);
      await rm(executable);
      await symlink(repository, executable);
      await writeFile(prefixFile, "SUDO_ASKPASS=/conflict\n");
      expect(await checkHomebrewConfiguration(executable, env)).toMatchObject({
        supported: false,
        reason: "conflict"
      });
    });

    it("refuses a dangling configuration parent instead of treating it as ordinary absence", async () => {
      await rm(path.dirname(prefixFile), { recursive: true });
      await symlink(path.join(directory, "missing directory"), path.dirname(prefixFile));
      expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(false);
    });

    it.each([
      [
        "inheritance filter",
        "",
        "",
        '[[ "$SUDO_ASKPASS" == /controlled && "$HOMEBREW_BASELINE_ASKPASS_SOCKET" == /status && -z "${BASELINE_ASKPASS_SOCKET+x}" && -z "${NONINTERACTIVE+x}" ]]'
      ],
      ["prefix override", "SUDO_ASKPASS=/prefix\n", "", '[[ "$SUDO_ASKPASS" == /prefix ]]'],
      [
        "user precedence",
        "SUDO_ASKPASS=/prefix\n",
        "SUDO_ASKPASS=/user\n",
        '[[ "$SUDO_ASKPASS" == /user ]]'
      ],
      ["empty assignment", "SUDO_ASKPASS=\n", "", '[[ -z "${SUDO_ASKPASS+x}" ]]'],
      [
        "unterminated final record",
        "SUDO_ASKPASS=/ignored",
        "",
        '[[ "$SUDO_ASKPASS" == /controlled ]]'
      ]
    ])("crosses unmodified bin/brew for %s", async (_name, prefix, user, assertion) => {
      await writeFile(prefixFile, prefix);
      await writeFile(userFile, user);
      const terminal = path.join(directory, "prefix/Library/Homebrew/brew.sh");
      await mkdir(path.dirname(terminal), { recursive: true });
      // Replace only the terminal fixture, never the launcher under test. No Ruby,
      // sudo, GUI, network, or actual mutation is reachable from this fixture.
      await writeFile(terminal, `#!/bin/bash\n${assertion}\n`);
      const child = spawnSync(executable, ["--version"], {
        env: {
          ...env,
          SUDO_ASKPASS: "/controlled",
          HOMEBREW_BASELINE_ASKPASS_SOCKET: "/status",
          BASELINE_ASKPASS_SOCKET: "/stripped",
          NONINTERACTIVE: "1",
          HOMEBREW_NO_ENV_HINTS: "1"
        },
        encoding: "utf8",
        timeout: 2000
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("");
      expect(child.stderr).toBe("");
    });
  }
);
