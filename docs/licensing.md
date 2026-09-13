# Licensing and distribution policy

Status: project licensing review updated on 2026-08-10.

The [#53](https://github.com/menaje/2d-cad-viewer/issues/53) proposal below
separates future development access from free application delivery. The existing
component license map and published recipients' rights remain in force.

This document records the repository's engineering policy. It is not legal
advice, does not replace the applicable license texts, and does not determine
whether two programs form one combined work under copyright law. When this
document conflicts with an upstream license or copyright notice, the upstream
terms control.

## Governing principles

1. Reproduce authoritative license texts, copyright notices, permission
   notices, warranty disclaimers, and liability limitations without editing
   their substance.
2. Keep project copyright and engineering explanations in `NOTICE`,
   `THIRD_PARTY_NOTICES.md`, or this policy instead of inserting them into an
   upstream license text.
3. Include notices according to what an artifact actually contains. The MPL
   VSIX contains only version-bound engine metadata, not the GPL adapter. Each
   separately published GPL converter is paired in the same release with its
   applicable license texts and complete corresponding source.
4. Tell executable-form recipients where they can obtain the matching
   preferred source form.
5. Treat a published artifact and its checksum as immutable. A licensing-file
   change requires a new versioned artifact; an old artifact or recorded hash
   is never silently replaced.

## Proposed free application and interoperability rights

Status: reviewable product plan, 2026-09-12; implementation access and artifact
terms have not changed. Subsequent first-party implementation is intended for
private development while a useful free standalone, read-only CAD Viewer remains
available. VS Code, web or desktop channel selection belongs to the product
owner. No account, separate authoring purchase or server-only execution is added
by this plan. Business use and commercial integration plugins are encouraged.

| Surface | Existing rights and proposed boundary | Owner |
| --- | --- | --- |
| Free application use | Preserve practical independent open/view/navigation tasks, including business use. Price and installation do not grant drawing modification or host acceptance authority. | Product maintainer |
| Supported render/source/host APIs | Preserve versioned host-neutral integration and commercially usable plugins on objective, consistently applied access conditions. A future restricted contract needs explicit access and use terms. | Public contract maintainer |
| SDK redistribution | Existing MPL package/source grants continue under their license. Any future SDK must identify its redistributable files and terms separately; no complete SDK or plugin market is promised by this plan. | Package and rights maintainer |
| Engine embedding | Existing MPL/GPL and third-party terms govern the actual included components. Free app use is not a new unrestricted grant for a future engine. | Artifact release/rights owner |
| Source redistribution | Existing OSS snapshots retain their grants. Restrictions on future code require confirmed ownership and applicable contribution/dependency review. | Copyright holders and release owner |

The minimum integration target is exact-version RenderSource → Core → ViewerHost
composition, optional Viewer UI, and the DWG Scene Source/WebGL adapter contracts
already documented in [architecture](architecture.md) and package READMEs. Preserve
source-neutral ownership, protocol/cache identities and fail-closed conformance.
The standalone extension's internal messages are not a supported integration API.
Do not forbid independent interoperable implementations merely because they
compete with this product.

Here, **supported** identifies a documented producer-owned contract, not whether
its implementation repository is publicly readable. Current access is the public
versioned package/release surface, with MPL use/modification/redistribution rights
for covered package files and the separately applicable third-party notices.
RenderSource/Core/ViewerHost and optional UI integrations consume the package
exports and compatibility manifests; DWG integrations additionally consume the
versioned Scene Cache and source adapter boundary. Each consumer pins the exact
archive and content identity and owns conformance/admission to its host. Public
availability alone does not establish that admission or support for every version.

If restricted access is later selected, the producer must state who may obtain
the contract/package, the authenticated endpoint and availability owner, permitted
API use and redistributable files, compatibility window and deprecation notice.
Conditions must apply consistently to independent and commercial plugin authors.
Consumers own their credentials, installation and rollback; they acquire exact
artifacts without access to an implementation checkout. No restricted SDK grant,
new support SLA or access restriction is activated by this plan.

Before changing a supported contract or its acquisition, identify the affected
versions and users, compatibility window, migration example and rollback in #53
and the owning API/compatibility document. Announce deprecation before removal;
do not use a source-access change to invalidate an admitted exact artifact.
Reductions in free entry, independent use or existing integration require an
impact explanation, alternatives and product/contract owner review before
execution. No new manual register, mandatory telemetry or recurring report is
required. SDK/market completion remains maturity-dependent backlog.

The release owner must check ownership of subsequent code, external contributions,
MPL-covered files and the bundled dependency inventory before selecting new terms.
Keep MPL source availability, the GPL converter's complete corresponding source
and all notices accessible to their recipients. A process boundary does not
by itself exempt a linked LibreDWG executable from GPL obligations. This plan
does not assert that an entire subsequent artifact can be closed-source.
Private source hosting also cannot prevent inspection of delivered JS, VSIX or
WASM; no anti-clone guarantee is made.

The [distribution continuity plan](distribution.md#proposed-delivery-continuity)
owns URL, installation and rollback conditions. Existing authoritative
[MPL terms](https://www.mozilla.org/en-US/MPL/2.0/), bundled GPL text and notices
continue to govern their covered code; this proposal does not replace them.

## Component and artifact map

| Component or artifact | License | Distribution policy |
| --- | --- | --- |
| Repository source and documentation, unless a file states otherwise | MPL-2.0 | `LICENSE` is the complete, unmodified official MPL 2.0 text; project copyright is in `NOTICE` |
| `dwg-viewer-vscode-<version>.vsix` | MPL-2.0, plus bundled MIT, ISC, and Apache-2.0 components | Includes `LICENSE.txt`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, a source link, and the filenames, sizes, and SHA-256 digests of separately released converters and source archives; contains no GPL executable and declares no engine-extension dependency |
| `dwg-viewer-native-converter-<version>-<target>[.exe]` | GPL-3.0-or-later | Platform executable built from the verified source-complete package and published separately in the matching `v<version>` GitHub Release |
| `dwg-viewer-libredwg-0.14-<target>.tar.gz` | GPL-3.0-or-later executable and LibreDWG source; adapter source retains MPL-2.0 notices | Complete corresponding source distribution containing the exact converter, LibreDWG source, adapter source, build scripts, unmodified GPLv3 and MPL 2.0 texts, manifest, and checksums |
| `@menaje/viewer-core`, `@menaje/viewer-render-protocol`, `@menaje/viewer-ui` | MPL-2.0 | Current packages include the unmodified official MPL text, project `NOTICE`, README, and source modules |
| `@menaje/viewer-webgl`, `@menaje/dwg-scene-source` | MPL-2.0, with MIT, ISC, and Apache-2.0 runtime dependencies used by WebGL | Public package archives include the unmodified official MPL text, project `NOTICE`, README, and source modules; dependency packages retain their own upstream licenses and notices |
| `@mlightcad/shx-parser` 1.4.5 | MIT | Bundled into the Webview; its copyright and full MIT permission notice are included in `THIRD_PARTY_NOTICES.md` |
| Earcut 3.2.3 | ISC | Bundled into the Webview; its copyright and full ISC permission notice are included in `THIRD_PARTY_NOTICES.md` |
| emf-converter 2.0.2 | Apache-2.0 | Bundled into the Webview for local, bounded OLE EMF preview rendering; its complete unmodified Apache license text and attribution notice are included in `THIRD_PARTY_NOTICES.md` |
| 2D CAD Viewer LibreDWG adapter source | MPL-2.0 | Included as corresponding adapter source in the separate engine archive |
| Linked LibreDWG adapter executable and GNU LibreDWG 0.14 | GPL-3.0-or-later | Published only in separate platform artifacts with the GPL text, exact LibreDWG source, adapter source, build scripts, manifest, and checksums |
| ACadSharp benchmark adapter source | MPL-2.0 | Development and qualification only; not part of the selected viewer runtime |
| ACadSharp 3.6.51 | MIT | Optional process-isolated benchmark dependency; not bundled in the VSIX |
| `dwg-converter` Rust tool | MPL-2.0 | Development and qualification tool; not included in the current VSIX or LibreDWG adapter release artifacts |

The Rust tool links registry crates under their recorded permissive licenses.
If that binary becomes a release artifact, its transitive dependency licenses
and required notices must be generated and reviewed before publication.

## MPL source availability

The VSIX contains compiled JavaScript and therefore distributes MPL-covered
code in executable form. The project satisfies its source-notice policy by:

1. identifying the VSIX as MPL-2.0 in its manifest and packaged README;
2. including the unmodified official MPL 2.0 text, project `NOTICE`, and
   third-party notices in the VSIX;
3. linking recipients to the complete repository source;
4. building a versioned release from a matching `v<version>` Git tag; and
5. retaining the source and build scripts needed to reproduce that version.

The historical `viewer-core-v0.1.0` packages use the same license identifier
and include the official Exhibit A notice, README, and preferred source form.
Mozilla permits that notice to be placed in a `LICENSE` file in a relevant
directory. The historical `viewer-core-v0.1.1` packages add the complete
official MPL text and separate project `NOTICE`. Both releases must be preserved
without replacement; this is a retention requirement, not a claim of GitHub-enforced
immutability. The 0.1.1 raw-digest discrepancy remains tracked in #53 with both
observations intact. The superseding `viewer-core-v0.1.2` and `viewer-core-v0.1.3`
packages preserve that license payload and use platform-normalized archives
whose actual hashes are verified by `pnpm run qualify:viewer-boundary`.

The `viewer-webgl-v0.1.1` package train follows the same rule. Both package
archives carry byte-identical copies of the repository's unmodified official
MPL text and keep project-specific copyright in `NOTICE`.

## GPL adapter boundary

The LibreDWG adapter executable statically links GNU LibreDWG and is conveyed
under GPL-3.0-or-later. It is not present in the MPL VSIX, and the main
extension declares no dependency on a separately listed engine extension.

The release workflow creates a separately named, source-complete GPL archive
for every platform and verifies its internal manifest, checksums, licenses, and
`doctor` result. The raw converter published for automatic installation is the
same verified executable. Its complete corresponding source is offered through
the target-matched archive in the same GitHub Release, using the same download
mechanism. That archive contains the exact checksum-pinned LibreDWG source,
the reviewed ACDS SAT/SAB and R2007 high-compression source patches, adapter
source and build scripts,
license texts, notice, manifest, and
checksums. `GPL-3.0-or-later.txt` is byte-identical to the GPLv3 `COPYING` file
conveyed in the pinned LibreDWG 0.14 source.

The MPL VSIX carries a generated catalog containing the exact converter and
source-archive names, byte lengths, and SHA-256 digests for all supported
targets. At startup, it downloads only its version-matched converter from the
same versioned release, verifies that catalog entry, installs it in VS Code's
private global storage, and runs `doctor`. A viewer update therefore cannot
silently select an independently versioned writer. The catalog metadata does
not copy or incorporate GPL program code into the VSIX.

At runtime, the extension starts the adapter as a separate operating-system
process. It does not load LibreDWG into the extension host or Webview. The
current boundary exchanges command options, bounded progress records, and
versioned Scene Cache files through `dwg-engine-adapter/1`.

The separate release files and process boundary are project controls, not a
categorical legal conclusion. The GNU GPL FAQ explains that the substance and
intimacy of communication between programs can affect whether they are treated
as a single combined program. Any change that places the adapter in the MPL
VSIX, links or loads LibreDWG into the extension host, shares in-process data
structures, stops offering equivalent access to complete corresponding source,
or materially expands the private protocol requires a new licensing review
before release.

## Third-party notice policy

The Webview production dependency audit is:

```bash
pnpm --filter @menaje/viewer-webgl licenses list --prod --json
```

The result must contain only reviewed versions. Because esbuild places the
Webview dependencies inside generated JavaScript rather than shipping their
original package folders, the VSIX must preserve their required copyright and
permission notices in `THIRD_PARTY_NOTICES.md`.

Development tools and rejected benchmark candidates remain listed separately
so their presence is not confused with bundled runtime code.

## Contributor and release checklist

- Treat new repository source as MPL-2.0 unless an approved file-level notice
  states otherwise.
- Preserve existing SPDX identifiers, copyright notices, license texts, and
  warranty disclaimers.
- Keep the root and packaged VSIX `LICENSE` byte-identical to Mozilla's
  official MPL 2.0 plain text. Keep project-specific notices outside it.
- Review every new runtime dependency before merging it and add its exact
  required notice before bundling.
- Do not copy GPL-covered LibreDWG code into the MPL VSIX or public Viewer
  packages.
- Build every linked LibreDWG artifact from the verified source-complete GPL
  package created by `adapters/libredwg/package.mjs`; never stage a raw
  converter from an unverified binary alone.
- Publish every platform converter and its source-complete archive in the
  versioned GitHub Release before publishing the MPL Marketplace extension
  whose catalog selects them.
- Re-run the Webview production-license audit and inspect the packaged VSIX.
- Require `pnpm run check` and the release gates in
  [`distribution.md`](distribution.md) before publication.

## Primary license references

- [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/)
- [Mozilla MPL 2.0 official plain text](https://www.mozilla.org/media/MPL/2.0/index.txt)
- [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)
- [GNU LibreDWG licensing statement](https://www.gnu.org/software/libredwg/)
- [VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [VS Code extension global storage](https://code.visualstudio.com/api/references/vscode-api#ExtensionContext)
