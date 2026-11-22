# RDCore.VSCode
<sup>_Ce document est disponible en [français](./README.fr.md)_</sup>

![VIVAT CUCUMIS](./assets/vivat-cucumis-stonecore.png)

## Before we begin.
> 👋 Hi! New here? _Rubberduck_ was always an open-source initiative. **RDCore honors it with an Open-Core formula**.  
> <small>See [rubberduckvba.ca](https://rubberduckvba.ca) for more information.</small>

This repository holds **RDCore for VS Code**, the extension that brings the language server and the debug adapter of an [RDCore](https://github.com/rubberduck-vba/RDCore) platform into Visual Studio Code, under **⚖️GPLv3 or later**.

The extension is a plain client of the platform: it speaks the standard Language Server Protocol 3.17 and Debug Adapter Protocol to a platform you install yourself, and what it shows comes from the platform. It sits between RDCore's shell (`rdc`), which runs code at a prompt, and the [HexIDE add-in](https://github.com/rubberduck-vba/RDCore.HexIDE), which adds features specific to its host.

The platform itself, the RD-VBA runtime included, lives in the [RDCore](https://github.com/rubberduck-vba/RDCore) repository and runs as separate processes. What you build with RDCore is yours (see [RDCore's NOTICE](https://github.com/rubberduck-vba/RDCore/blob/main/NOTICE.md)).

## Project Status
RDCore is in active **alpha** development, and this extension with it.

## What you get

The language server serves the modules of RD-VBA and VB6 projects: `.bas`, `.cls`, `.frm`, `.ctl`, `.pag`, `.dob`, `.doccls` and `.rdform`.

| Area | What VS Code shows |
|---|---|
| Editing | Completion, signature help, hover, inlay hints, formatting, folding, linked editing of a local name |
| Navigation | Go to Definition, Declaration and Implementation, Find References, document and workspace symbols, call and type hierarchy |
| Analysis | Diagnostics with code actions (quick fixes and refactorings), code lenses, semantic highlighting |
| Refactoring | Rename by binding, and the platform's refactorings as code actions |
| Debugging | Running or debugging the workspace's program, breakpoints and conditional breakpoints, stepping, inline values, the debug console |

Highlighting comes from the language server's semantic tokens: the extension has no TextMate grammar.

## Requirements

- **An RDCore platform:** a release from [RDCore's releases](https://github.com/rubberduck-vba/RDCore/releases), such as [v0.2.5-alpha](https://github.com/rubberduck-vba/RDCore/releases/tag/v0.2.5-alpha) or later, or a platform you built from source. With an earlier release, VS Code can start without completion, hover, semantic highlighting and the server's other features. RDCore's [getting started](https://rubberduck-vba.github.io/RDCore/getting-started.html) page says how to get one.
- **The .NET runtime that platform needs:** [.NET 11](https://dotnet.microsoft.com/download/dotnet/11.0) for v0.2.5-alpha.
- **Visual Studio Code** 1.146 or later.

## Installing

Download the extension's `.vsix` file, `rdcore-vscode-<version>.vsix`, from the [releases](https://github.com/rubberduck-vba/RDCore.VSCode/releases): for example `rdcore-vscode-0.1.0-alpha.vsix`. `SHA256SUMS` beside it lets you check the download.

Then, in VS Code, run **Extensions: Install from VSIX...** from the Command Palette and pick the file, or run:

```powershell
code --install-extension rdcore-vscode-0.1.0-alpha.vsix
```

VS Code shows the extension's version without the release's suffix: `0.1.0` for `0.1.0-alpha`. [Building from source](#building-from-source) says how to make the `.vsix` yourself.

## Settings

| Setting | Value |
|---|---|
| `rdcore.platformRoot` | The platform root: the folder of the platform's `rdcore.json` manifest. Required. |
| `rdcore.trace.server` | `off` (the default), `messages` or `verbose`: traces the protocol in the **RDCore** output channel. |

The platform root is the folder of an extracted release archive, a version that `rdc install` installed (`RDCore/Platform/versions/<version>/` in your local application data folder), or the `artifacts/rdcore-dev` folder of a platform you built:

```json
{
  "rdcore.platformRoot": "C:\\Dev\\RDCore\\artifacts\\rdcore-dev"
}
```

When the setting is missing, or the folder is not a platform, the extension says so, with a button that opens the setting. A change to the setting restarts the language server, and the **RDCore: Restart the Language Server** command restarts it at any time.

## Opening a workspace

Open the folder of an RDCore project: the folder that has the `.rdproj` file. The extension starts when the folder has one, or when you open a module. It opens the folder of the first `.rdproj` it finds as the platform's workspace.

The extension opens `.bas` and `.cls` files as VBA (`files.associations`), because VS Code's own Visual Basic and TeX languages also claim them. Another extension can claim a module's file extension too, and the module then opens in that extension's language. The language server still serves it, by its file, and the other extension's features apply to it as well. To open it as VBA, pick **VBA** from the language indicator in the status bar, or add the association to your settings:

```json
{
  "files.associations": { "*.bas": "vba" }
}
```

## Debugging

Press F5. With no `launch.json`, the extension runs the program from its entry point: `Main`, in the one standard module that declares it. To choose another, add a configuration of type `rdcore` (the **RDCore: Launch** snippets):

```json
{
  "type": "rdcore",
  "request": "launch",
  "name": "Run the program (RDCore)",
  "module": "Program",
  "entryPoint": "Main"
}
```

| Attribute | Meaning |
|---|---|
| `module` | The module that has the entry point. Without it, the one standard module that declares the entry point. |
| `entryPoint` | The procedure the program starts with: `Main` by default. |
| `noDebug` | Runs the program without debugging it. |

An `attach` configuration (**RDCore: Attach**) brings the platform up for the workspace without running a program, and the debug console runs statements as at a prompt.

## Building from source

From the repository root, with Node.js and npm:

```powershell
npm install
npm run package
```

`npm run package` checks the types, bundles the extension and writes `rdcore-vscode-<version>.vsix` with `vsce package`.

- `npm run build` bundles the extension into `dist/`, and `npm run watch` keeps doing it.
- F5 in this repository starts an Extension Development Host on `samples/hello`, a small project to try the extension on.
- `npm run smoke` starts the language server and the debug adapter of a platform with the extension's own launch code, sends each its `initialize` request, and prints what they answer. It then runs the sample program to a conditional breakpoint. It takes `--platform-root <folder>` (or `RDCORE_SMOKE_PLATFORM_ROOT`) and `--workspace <folder>`.

### How it starts the platform

- **Language server:** the executable that the manifest names as `langService`, under the platform root, started in its own folder with `--pipe-name <name> --workspace <folder URI> --client-process-id <pid>`, and `RDCORE_PLATFORM_ROOT` set to the platform root. The server listens on the pipe and the extension connects to it: `\\.\pipe\<name>` on Windows, a Unix domain socket in the temporary folder elsewhere.
- **Debug adapter:** the same executable, with `--dap --workspace <folder URI>`, speaking DAP over its standard input and output.

## License
RDCore.VSCode is licensed under the GNU General Public License, version 3 or any later version: see [LICENSE-GPLv3.md](LICENSE-GPLv3.md). The license file reproduces the official text, in English. A French version of the license is available on request.

To report a problem, open an [issue](https://github.com/rubberduck-vba/RDCore.VSCode/issues).

---
### See also
- [RDCore](https://github.com/rubberduck-vba/RDCore)
- [RDCore.SDK](https://github.com/rubberduck-vba/RDCore.SDK)
- [RDCore.HexIDE](https://github.com/rubberduck-vba/RDCore.HexIDE)

<hr/>
<p align='left' style='margin-left: 32px;'>
<a href='https://rubberduck-vba.github.io/RDCore/index.fr.html'>ACCUEIL</a> • <a href='https://rubberduck-vba.github.io/RDCore/index.html'>HOME</a>  | ℹ️ <a href='https://rubberduck-vba.github.io/RDCore/introduction.fr.html'>BIENVENUE</a> • <a href='https://rubberduck-vba.github.io/RDCore/introduction.html'>WELCOME</a>  | 🧩 <a href='https://rubberduck-vba.github.io/RDCore/getting-started.fr.html'>BÂTISSONS</a> • <a href='https://rubberduck-vba.github.io/RDCore/getting-started.html'>BUILD</a>  | <a href='https://rubberduck-vba.github.io/RDCore/specs/rd-vbal.html'><strong>RD-VBAL</strong></a>  |  <a href='https://rubberduck-vba.github.io/RDCore/api/RDCore.SDK.Model.Errors.VBCompileErrorId.html'>SDK</a>  | 🌐 <a href='https://rubberduckvba.ca'>rubberduckvba.ca</a>
</p>
<hr/>
<p align='center'><img alt='Logo™ 9562-7303 Québec inc.' src='./assets/ducky.png' style='width:200px; align:center;' /></p>
<h6 align='center'>V I V A T ❤️ C U C U M I S ™</h6>
<p align='center' style='font-size:8pt;'>
<small>© Copyright <strong>9562-7303 Québec inc.</strong> (2026)<br/><em>Seul, &quot;Rubberduck&quot; est utilisé pour fins de référence au projet open-source legacy <strong>utilisé publiquement ainsi depuis 2015</strong> et sans lien ni affiliation avec tout tiers détenteur d'une marque semblable dans quelque juridiction que ce soit.<br/>&quot;Rubberduck VBA&quot;, &quot;RDCore&quot; et &quot;VIVAT CUCUMIS&quot; sont des marques de commerce revendiquées par 9562-7303 Québec inc. (en attente); Toutes les marques appartiennent à leur détenteur respectif.<br/>RDCore n'est pas un produit de Microsoft et n'est pas affilié à Microsoft, ni directement, ni indirectement.<br/><br/>If used alone, <em>&quot;Rubberduck&quot; is used as a reference to the legacy open-source project <strong>the same way it has been used publicly since 2015</strong> and without any links or affiliation with any third-party trademark holders of a similar trademark in any jurdisdiction.<br/>&quot;Rubberduck VBA&quot;, &quot;RDCore&quot; and &quot;VIVAT CUCUMIS&quot; are trademarks claimed by 9562-7303 Québec inc. (pending). All trademarks belong to their respective owners.<br/>RDCore is not a Microsoft product and is not affiliated with Microsoft, directly or indirectly.</small>
</p>
