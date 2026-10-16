// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildInstalledMetadata } from "../src/main/homebrewInstalledMetadata";
import type { HomebrewManagedItem } from "../src/shared/domain";
import { version } from "../src/shared/version";

// Projection of Formula#to_hash / Tab#formula_to_dep_hash, not raw Tab JSON.
// Source: Homebrew 7.0.4 edb70f031e4170c780799633a1226ff73e1077f4 and
// current main 19fe946b9a257cb41ebb5cef5c592ba7923d1f3b (see transport crosswalk).
const declarations = (token: string) => ({
  dependencies: [token],
  build_dependencies: ["cmake"],
  test_dependencies: ["pytest"],
  recommended_dependencies: ["recommended-lib"],
  optional_dependencies: ["optional-lib"]
});
const receipt = (installedVersion = "1.0_2", overrides: Record<string, unknown> = {}) => ({
  version: installedVersion,
  used_options: [],
  built_as_bottle: false,
  poured_from_bottle: true,
  time: 1700000000,
  runtime_dependencies: [],
  installed_on_request: false,
  ...overrides
});
const formula = (overrides: Record<string, unknown> = {}) => ({
  name: "tool",
  full_name: "tool",
  tap: "homebrew/core",
  oldnames: [],
  versions: { stable: "2.0", head: "HEAD", bottle: true },
  revision: 4,
  version_scheme: 1,
  ...declarations("stable-only"),
  installed: [receipt()],
  ...overrides
});
const item = (token = "tool", tap = "homebrew/core"): HomebrewManagedItem => ({
  id: `formula:${token}`,
  name: token,
  token,
  kind: "formula",
  installedVersion: version("1.0_2"),
  isOutdated: false,
  fullToken: tap === "homebrew/core" ? token : `${tap}/${token}`,
  tap,
  formulaIdentityVerified: true,
  formulaIdentity: {
    name: token,
    fullName: tap === "homebrew/core" ? token : `${tap}/${token}`,
    tap,
    oldNames: []
  }
});
const command = (payload: unknown) => ({
  success: true,
  status: 0,
  output: JSON.stringify(payload)
});
const metadata = (raw: Record<string, unknown>) =>
  buildInstalledMetadata([item()], command({ formulae: [raw] }), command({ casks: [] }))[
    "formula:tool"
  ]!;

describe("installed metadata serializer contract", () => {
  it.each([true, false, undefined, null, "false", 0])(
    "retains only observed install intent %j without inferring cause",
    (intent) => {
      const result = metadata(
        formula({
          installed: [
            receipt("1.0_2", {
              installed_on_request: intent,
              installed_as_dependency: true,
              revision: 99
            })
          ]
        })
      );
      const expected = typeof intent === "boolean" ? intent : undefined;
      expect(result.installedOnRequest).toBe(expected);
      expect(result.installedReceipts[0]?.installedOnRequest).toBe(expected);
      expect(result.revision).toBe(4);
      expect(result.installedReceipts[0]).not.toHaveProperty("revision");
      expect(result).not.toHaveProperty("installedAsDependency");
      expect(result.installedReceipts[0]).not.toHaveProperty("installedAsDependency");
    }
  );

  it.each([
    { intents: [false, false], expected: false },
    { intents: [false, undefined], expected: undefined },
    { intents: [true, undefined], expected: true },
    { intents: [false, true], expected: true },
    { intents: [undefined, undefined], expected: undefined }
  ])(
    "preserves mixed per-keg intent while aggregating observed values: %j",
    ({ intents, expected }) => {
      const result = metadata(
        formula({
          installed: intents.map((intent, index) =>
            receipt(index ? "HEAD-aabbcc_1" : "1.0_2", { installed_on_request: intent })
          )
        })
      );
      expect(result.installedOnRequest).toBe(expected);
      expect(result.installedReceipts.map((r) => r.installedOnRequest)).toEqual(intents);
      expect(result.installedReceipts.map((r) => r.spec)).toEqual(["stable", "head"]);
    }
  );

  it.each([
    { versions: ["1.0_2"], expected: [["stable-only", "stable", "stable"]] },
    { versions: ["HEAD-aabbcc_1"], expected: [["head-only", "head", "head"]] },
    {
      versions: ["1.0_2", "HEAD-aabbcc_1"],
      expected: [
        ["stable-only", "stable", "stable"],
        ["head-only", "head", "head"]
      ]
    }
  ])(
    "selects current declarations for installed stable/HEAD specs: %j",
    ({ versions, expected }) => {
      const result = metadata(
        formula({
          installed: versions.map((v) => receipt(v)),
          head_dependencies: declarations("head-only")
        })
      );
      const declared = result.dependencies.filter((d) => d.source === "declaration");
      expect(
        declared
          .filter((d) => d.scope === "runtime")
          .map((d) => [d.token, d.spec, d.declarationSource])
      ).toEqual(expected);
      expect(declared.filter((d) => d.scope === "build").every((d) => d.token === "cmake")).toBe(
        true
      );
      for (const scope of ["runtime", "build", "test", "recommended", "optional"]) {
        expect(declared.filter((d) => d.scope === scope)).toHaveLength(versions.length);
      }
    }
  );

  it("treats omitted equal HEAD declarations as shared while retaining both specs", () => {
    const result = metadata(formula({ installed: [receipt(), receipt("HEAD-aabbcc")] }));
    expect(
      result.dependencies
        .filter((d) => d.scope === "runtime")
        .map((d) => [d.token, d.spec, d.declarationSource])
    ).toEqual([
      ["stable-only", "stable", "stable"],
      ["stable-only", "head", "shared"]
    ]);
  });

  it.each(["HEAD", "HEAD_2", "HEAD-aabbcc_1", "HEAD-nonhex-ref_3", "HEAD-"])(
    "uses Homebrew's HEAD predicate and package revision encoding for %s",
    (installedVersion) => {
      const result = metadata(
        formula({
          installed: [receipt(installedVersion)],
          head_dependencies: declarations("head-only")
        })
      );
      expect(result.installedReceipts[0]?.spec).toBe("head");
      expect(result.dependencies.find((dep) => dep.scope === "runtime")).toMatchObject({
        token: "head-only",
        spec: "head"
      });
    }
  );

  it.each([
    null,
    [],
    "malformed",
    false,
    { dependencies: ["head-only", null, "--bad"], build_dependencies: 7 }
  ])(
    "never replaces explicitly malformed/partial HEAD declarations with stable declarations: %j",
    (head) => {
      const result = metadata(
        formula({ installed: [receipt("HEAD-aabbcc")], head_dependencies: head })
      );
      expect(result.dependencies.every((d) => d.token !== "stable-only")).toBe(true);
      expect(result.dependencies.map((d) => d.token)).toEqual(
        typeof head === "object" && head !== null && !Array.isArray(head) ? ["head-only"] : []
      );
    }
  );

  it("leaves declarations unknown for removed HEAD specs or malformed installed records", () => {
    for (const raw of [
      formula({ installed: [receipt("HEAD-aabbcc")], versions: { stable: "2", head: null } }),
      formula({ installed: [receipt("bad value")] })
    ])
      expect(metadata(raw).dependencies).toEqual([]);
  });

  it("keeps current formula scalar metadata separate from historical keg versions", () => {
    const result = metadata(
      formula({
        caveats: "Private /Users/fixture instruction",
        deprecated: false,
        deprecation_date: "2027-02-01",
        deprecation_reason: "scheduled",
        disabled: true,
        disable_date: "2026-02-01",
        disable_reason: "unsupported",
        auto_updates: true,
        installed: [receipt("1.0_2", { revision: 99 })]
      })
    );
    expect(result).toMatchObject({
      stableVersion: "2.0",
      headVersion: "HEAD",
      revision: 4,
      versionScheme: 1,
      caveats: "Private /Users/fixture instruction",
      deprecated: false,
      deprecationDate: "2027-02-01",
      deprecationReason: "scheduled",
      disabled: true,
      disableDate: "2026-02-01",
      disableReason: "unsupported"
    });
    expect(result.autoUpdates).toBeUndefined();
    expect(result.caskVersion).toBeUndefined();
    expect(result.installedReceipts[0]?.version).toBe("1.0_2");
  });

  it.each([undefined, null, [], {}, 7, false])(
    "ignores unknown/malformed scalar values: %j",
    (value) => {
      const result = metadata(
        formula({
          caveats: value,
          deprecated: value,
          deprecation_date: value,
          deprecation_reason: value,
          disabled: value,
          disable_date: value,
          disable_reason: value,
          revision: value,
          version_scheme: value,
          versions: { stable: value, head: value },
          installed: [receipt("1.0", { installed_on_request: value, time: value })]
        })
      );
      for (const field of [
        "caveats",
        "deprecationDate",
        "deprecationReason",
        "disableDate",
        "disableReason",
        "stableVersion",
        "headVersion"
      ]) {
        expect(result[field as keyof typeof result]).toBeUndefined();
      }
      expect(result.deprecated).toBe(typeof value === "boolean" ? value : undefined);
      expect(result.disabled).toBe(typeof value === "boolean" ? value : undefined);
      expect(result.revision).toBe(typeof value === "number" ? value : undefined);
    }
  );

  it("rejects invalid dates, unsafe integers and malformed records without fabricating observations", () => {
    const result = metadata(
      formula({
        deprecation_date: "2026-02-30",
        disable_date: "not-a-date",
        revision: -1,
        version_scheme: Number.MAX_SAFE_INTEGER + 1,
        dependencies: ["valid-declared", 1, "--bad"],
        installed: [
          null,
          [],
          { version: 7 },
          { version: "" },
          { version: "bad value" },
          receipt("1", {
            time: -1,
            runtime_dependencies: [null, "legacy-name", { full_name: "--bad" }]
          })
        ]
      })
    );
    expect(result.deprecationDate).toBeUndefined();
    expect(result.disableDate).toBeUndefined();
    expect(result.revision).toBeUndefined();
    expect(result.versionScheme).toBeUndefined();
    expect(result.installedReceipts).toHaveLength(1);
    expect(result.installedReceipts[0]?.time).toBeUndefined();
    expect(result.installedReceipts[0]?.runtimeDependencies).toEqual([]);
    expect(result.dependencies.filter((d) => d.scope === "runtime").map((d) => d.token)).toEqual([
      "valid-declared"
    ]);
  });

  it("retains distinct receipt reference versions and resolves only exact verified identities", () => {
    const dep = {
      full_name: "lib",
      version: "2.0",
      revision: 3,
      pkg_version: "2.0_3",
      declared_directly: true
    };
    const raw = formula({
      installed: [
        receipt("1.0_2", { runtime_dependencies: [dep] }),
        receipt("HEAD-aabbcc", {
          runtime_dependencies: [dep, { full_name: "other/tools/lib" }, { full_name: "tool" }]
        })
      ],
      dependencies: ["lib"]
    });
    const results = buildInstalledMetadata(
      [item(), item("lib")],
      command({ formulae: [raw, formula({ name: "lib", full_name: "lib" })] }),
      command({ casks: [] })
    );
    const observed = results["formula:tool"]!.dependencies.filter((d) => d.source === "receipt");
    expect(observed[0]).toMatchObject({
      token: "lib",
      version: "2.0",
      pkgVersion: "2.0_3",
      revision: 3,
      declaredDirectly: true,
      receiptVersion: "1.0_2",
      spec: "stable",
      installedItemID: "formula:lib"
    });
    expect(observed[1]).toMatchObject({ receiptVersion: "HEAD-aabbcc", spec: "head" });
    expect(observed[2]?.installedItemID).toBeUndefined();
    expect(observed[3]?.installedItemID).toBeUndefined();
    expect(results["formula:lib"]!.installedDependents).toEqual(["formula:tool"]);
    expect(
      results["formula:tool"]!.dependencies.filter((d) => d.source === "declaration").every(
        (d) => d.installedItemID === undefined
      )
    ).toBe(true);
  });

  it("does not resolve ambiguous or unverified target identities", () => {
    const lib = item("lib");
    const duplicate = { ...lib, id: "formula:historical-lib" };
    for (const targets of [[lib, duplicate], [{ ...lib, formulaIdentityVerified: false }]]) {
      const result = buildInstalledMetadata(
        [item(), ...targets],
        command({
          formulae: [
            formula({
              installed: [
                receipt("1", {
                  runtime_dependencies: [{ full_name: "lib", pkg_version: 7, version: "2" }]
                })
              ]
            }),
            formula({ name: "lib", full_name: "lib" })
          ]
        }),
        command({ casks: [] })
      );
      const observed = result["formula:tool"]!.dependencies.find((d) => d.source === "receipt")!;
      expect(observed.installedItemID).toBeUndefined();
      expect(observed.version).toBe("2");
      expect(observed.pkgVersion).toBeUndefined();
    }
  });

  it.each([null, { legacy: "lib" }, ["legacy-name"], [null, [], 3]])(
    "does not invent runtime reference records from legacy or unknown Tab shapes: %j",
    (runtime) => {
      expect(
        metadata(formula({ installed: [receipt("1", { runtime_dependencies: runtime })] }))
          .installedReceipts[0]?.runtimeDependencies
      ).toEqual([]);
    }
  );

  it("does not fill missing dependency fields from current formula versions", () => {
    const result = metadata(
      formula({
        installed: [
          receipt("HEAD-aabbcc", {
            runtime_dependencies: [
              {
                full_name: "lib",
                version: "bad value",
                pkg_version: 7,
                revision: -1,
                declared_directly: "false"
              }
            ]
          })
        ]
      })
    );
    const reference = result.dependencies.find((dep) => dep.source === "receipt")!;
    expect(reference).toMatchObject({ token: "lib", spec: "head", receiptVersion: "HEAD-aabbcc" });
    expect(reference.version).toBeUndefined();
    expect(reference.pkgVersion).toBeUndefined();
    expect(reference.revision).toBeUndefined();
    expect(reference.declaredDirectly).toBeUndefined();
    expect(metadata(formula({ tap: "wrong/tap" }))).toBeUndefined();
  });

  it.each([undefined, null, [], {}, false, -1, 1.5, "bad value"])(
    "keeps malformed Cask info unknown instead of borrowing formula values: %j",
    (value) => {
      const caskItem: HomebrewManagedItem = {
        id: "cask:app",
        token: "app",
        name: "app",
        kind: "cask",
        fullToken: "app",
        tap: "homebrew/cask",
        installedVersion: version("1"),
        isOutdated: false
      };
      const result = buildInstalledMetadata(
        [caskItem],
        command({ formulae: [] }),
        command({
          casks: [
            {
              token: "app",
              full_token: "app",
              tap: "homebrew/cask",
              version: value,
              installed: value,
              installed_time: value,
              auto_updates: value,
              depends_on: value,
              versions: { stable: "99", head: "HEAD" },
              revision: 99,
              version_scheme: 99
            }
          ]
        })
      )[caskItem.id]!;
      expect(result.caskVersion).toBeUndefined();
      expect(result.caskInstalledVersion).toBeUndefined();
      expect(result.caskInstalledTime).toBeUndefined();
      expect(result.autoUpdates).toBe(value === false ? false : undefined);
      expect(result.installedReceipts).toEqual([]);
      expect(result.dependencies).toEqual([]);
      expect(result.stableVersion).toBeUndefined();
    }
  );

  it("retains Cask info version/time without inventing formula-style receipts or fields", () => {
    const caskItem: HomebrewManagedItem = {
      id: "cask:app",
      token: "app",
      name: "app",
      kind: "cask",
      fullToken: "app",
      tap: "homebrew/cask",
      installedVersion: version("1"),
      isOutdated: false
    };
    const result = buildInstalledMetadata(
      [caskItem],
      command({ formulae: [] }),
      command({
        casks: [
          {
            token: "app",
            full_token: "app",
            tap: "homebrew/cask",
            installed: "1,100",
            installed_time: 1700000000,
            version: "2,200",
            auto_updates: false,
            caveats: "App caveat",
            deprecated: true,
            deprecation_date: "2026-01-01",
            deprecation_reason: "unmaintained",
            disabled: false,
            depends_on: { formula: ["lib", null, "--bad"], cask: ["other-app"] },
            revision: 99,
            version_scheme: 99,
            versions: { stable: "99", head: "HEAD" },
            installed_on_request: true
          }
        ]
      })
    )[caskItem.id]!;
    expect(result).toMatchObject({
      caskVersion: "2,200",
      caskInstalledVersion: "1,100",
      caskInstalledTime: 1700000000,
      autoUpdates: false,
      deprecated: true,
      caveats: "App caveat"
    });
    expect(result.installedReceipts).toEqual([]);
    for (const field of [
      "stableVersion",
      "headVersion",
      "revision",
      "versionScheme",
      "installedOnRequest"
    ])
      expect(result[field as keyof typeof result]).toBeUndefined();
    expect(result.dependencies.map((d) => [d.kind, d.token])).toEqual([
      ["formula", "lib"],
      ["cask", "other-app"]
    ]);
    expect(
      result.dependencies.every(
        (d) => d.source === "declaration" && d.installedItemID === undefined
      )
    ).toBe(true);
  });
});
