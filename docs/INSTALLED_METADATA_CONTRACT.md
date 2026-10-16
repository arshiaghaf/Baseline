# Installed metadata source contract

Audited against official Homebrew source without executing Homebrew:

- Current main snapshot `19fe946b9a257cb41ebb5cef5c592ba7923d1f3b`:
  [Formula#to_hash](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/formula.rb#L3111),
  [Formula#dependencies_hash](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/formula.rb#L3365),
  [Tab initialization](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/tab.rb#L61),
  [Tab.formula_to_dep_hash](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/tab.rb#L156),
  [Cask#to_h](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/cask/cask.rb#L555),
  [Cask dependency arrays](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/cask/dsl/depends_on.rb#L45),
  [PkgVersion encoding](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/pkg_version.rb#L23),
  [Version HEAD predicate](https://github.com/Homebrew/brew/blob/19fe946b9a257cb41ebb5cef5c592ba7923d1f3b/Library/Homebrew/version.rb#L519).
- Version 7.0.4, commit `edb70f031e4170c780799633a1226ff73e1077f4`:
  [Formula](https://github.com/Homebrew/brew/blob/edb70f031e4170c780799633a1226ff73e1077f4/Library/Homebrew/formula.rb),
  [Tab](https://github.com/Homebrew/brew/blob/edb70f031e4170c780799633a1226ff73e1077f4/Library/Homebrew/tab.rb),
  [Cask](https://github.com/Homebrew/brew/blob/edb70f031e4170c780799633a1226ff73e1077f4/Library/Homebrew/cask/cask.rb).

The relevant producer schemas agree in these snapshots. Tests use projections of
these serializers, not direct raw Tab files. This audit does not certify every
historical Homebrew schema. Unknown shapes remain unavailable observations.

## Complete field crosswalk

| Sidecar field | Actual producer / derivation | Provenance and unknown-value policy |
| --- | --- | --- |
| `identity`, `kind`, record key | Fresh item verified by the inventory identity layer; matching formula `name/full_name/tap` or cask `token/full_token/tap` | One matching installed metadata entry required. No public catalogue or short-name repair. The sidecar adds no mutation authorization. |
| `caveats` | Formula `caveats_with_placeholders`; Cask `caveats_for_api` serialized as `caveats` | String or unknown; retained only in memory, never automatically exported. Formula placeholders are preserved, not resolved into paths. |
| `deprecated`, `disabled` | Formula/Cask corresponding booleans | Explicit true/false only. Missing, null or other types are unknown. |
| `deprecationDate`, `disableDate` | Formula/Cask `deprecation_date`, `disable_date` | Valid calendar `YYYY-MM-DD` strings only. Future dates remain available independently of the current boolean. |
| `deprecationReason`, `disableReason` | Formula/Cask corresponding reason strings | Strings or unknown; not inferred from dates or flags. |
| `stableVersion`, `headVersion` | Formula current `versions.stable`, `versions.head` | Nonempty version strings without whitespace. Current available definitions, not installed keg versions or installed HEAD commit IDs. Casks do not supply these fields. |
| `revision`, `versionScheme` | Formula current top-level `revision`, `version_scheme` | Nonnegative safe integers or unknown. These are not installed per-keg revision evidence. Cross-kind cask fields are ignored. |
| `autoUpdates` | Cask `auto_updates` | Explicit boolean or unknown. Not read from formula data and never replaces greedy outdated detection. |
| `caskVersion` | Cask current `version` | Direct cask info, retaining comma suffixes and `latest`; not formula stable-version metadata. |
| `caskInstalledVersion`, `caskInstalledTime` | Cask `installed`, `installed_time` | Direct cask installed-version string and nonnegative safe integer Unix time. Not formula-style installed receipts. |
| `installedReceipts[].version` | Formula `installed_kegs` serialization: `keg.version.to_s` | Original nonempty version string, including revision suffixes and HEAD commit suffixes. Malformed records are omitted, not fabricated. Casks have zero such records. |
| `installedReceipts[].spec` | Recognized installed version syntax | Matches `PkgVersion` revision-suffix parsing and `Version#head?`: underlying `HEAD` or `HEAD-<commit>` identifies HEAD (commit strings need not be hex). Other valid version strings identify stable; missing or malformed version records are not assigned a spec. |
| `installedReceipts[].time` | Formula serializer `tab.time` | Nonnegative safe integer or unknown, no fallback to current release date or cask time. |
| `installedReceipts[].installedOnRequest` | Formula serializer `tab.installed_on_request` | Explicit observed boolean only. Tab defaults old/missing intent to false before serialization, so false does not prove historical dependency cause. |
| `installedOnRequest` | Aggregate of the above observed keg booleans | True if any record reports true; false only when all retained records report false; otherwise unknown. Individual mixed values remain available. No inferred cause flag. |
| `installedReceipts[].runtimeDependencies` | Formula serializer passes through `tab.runtime_dependencies` | Retain recognized object records only. Nil, legacy strings/hashes and malformed entries do not become invented references. An empty retained list is an observed subset, not proof of no dependencies. |
| Dependency `token`, `kind`, `scope`, `source` for receipt edges | Tab runtime `full_name`; formula/runtime/receipt tags | Valid full-name token syntax required. Raw references remain exact; custom taps are never stripped. |
| Receipt dependency `version`, `pkgVersion`, `revision`, `declaredDirectly` | `Tab.formula_to_dep_hash`: `version`, `pkg_version`, `revision`, `declared_directly` | Separate observed version/package-version strings; integer revision; explicit boolean. No package version is fabricated from current formula metadata. Invalid one field does not hide another valid field. |
| Receipt dependency `receiptVersion`, `spec` | Containing installed keg record | Preserves which installed keg supplied the historical reference, including mixed stable/HEAD installations. |
| Declared dependency `token`, `kind`, `scope`, `source` | Formula five dependency arrays, or Cask `depends_on.formula/cask` | Valid array entries only. Scope is runtime/build/test/recommended/optional as explicitly serialized; Cask references are runtime declarations. Missing/malformed arrays remain unobserved. |
| Declared dependency `spec`, `declarationSource` | Formula current stable top-level arrays or nested `head_dependencies` | Only specs represented by retained installed keg records are included. Differing HEAD declarations are tagged `head`; omitted equal HEAD declarations are tagged `shared` only while current HEAD exists. Mixed installations retain both labeled sets. |
| Dependency `installedItemID` | Exact unique match of receipt `full_name` to a verified installed formula identity | Receipt references only. Declarations, custom-tap mismatches, ambiguous targets, self references and unverified targets remain unresolved. Version association is historical receipt context, not proof that the same dependency version is currently installed. |
| `installedDependents` | Reverse of the resolved receipt references | Deduplicated, sorted source item IDs across retained installed kegs. No inferred declaration edges or cask receipt edges. |

## Deliberate omissions and partial data

`installed_as_dependency` is a long-removed raw Tab attribute and is not emitted
by Formula's installed-keg serializer. The sidecar omits `installedAsDependency`
entirely rather than infer a cause from `installed_on_request: false`. The
serializer also emits no per-keg `revision`; that unsupported field is omitted.
Current top-level formula revision and historical runtime dependency revision
remain separate observed fields.

The installed-keg serializer also emits `used_options`, `built_as_bottle` and
`poured_from_bottle`; these are intentionally outside this minimal sidecar.
Likewise, `uses_from_macos`, requirements, conflicts, `no_linkage_dependencies`
and platform constraints are not promoted to complete graph edges. Cask info
does not emit formula-style keg records, install intent or receipt runtime edges.
Its version/time are retained directly, and `installedReceipts` is empty.

Explicit malformed/null `head_dependencies` does not authorize a stable fallback.
When that key is absent, Formula may have omitted equal stable/HEAD dependency
sets. The shared interpretation requires current HEAD metadata; if HEAD is no
longer available, the historical HEAD declaration set remains unknown. Valid
pieces of a partial object are retained without claims about the missing pieces.

The safe-context consumer counts distinct observed declared references,
distinct observed receipt runtime references and reverse observed dependent IDs.
It does not need new completeness flags. Counts of zero can mean unavailable or
filtered metadata. Mixed declaration specs and duplicate receipt references can
share a token; the consumer must continue deduplicating token/kind pairs. Actual
formula record counts remain `installedReceipts.length`; cask record count is
correctly zero. The integration owner removes the unsupported cause flag from
the new safe-context type/getter/tests. No renderer/API expansion is required.

`homebrewInstalledMetadata.test.ts` covers producer-shaped records, all consumed
scalar types, stable/HEAD/equal/mixed declarations, unavailable or malformed HEAD
data, all supported dependency scopes, unsupported legacy fields, per-keg versus
current versions, cask info separation, unknown values and exact graph matching.
The existing inventory tests continue to cover identity verification, partial
failure recovery, pin/rename/tap continuity and cleanup quarantine.
