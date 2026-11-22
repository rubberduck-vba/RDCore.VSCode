**Preview build.** RDCore for VS Code {VERSION} is for evaluation, not a certified build.

Built from commit [`{SHORT}`]({REPOSITORY}/commit/{COMMIT}) by [this workflow run]({RUN}).

### Download

| File | What it is |
|---|---|
| `rdcore-vscode-{VERSION}.vsix` | The extension |
| `SHA256SUMS` | The checksum of the `.vsix` |

VS Code shows the extension's version without the release's suffix.

### Requirements

- **An RDCore platform:** a release from [RDCore's releases](https://github.com/rubberduck-vba/RDCore/releases), or a platform built from source, with the .NET runtime that platform needs.
- **Visual Studio Code** 1.146 or later.

### Installing

- In VS Code, run **Extensions: Install from VSIX...** from the Command Palette and pick the file, or run `code --install-extension rdcore-vscode-{VERSION}.vsix`.
- Set `rdcore.platformRoot` to the platform root: the folder of the platform's `rdcore.json` manifest.
- Open the folder of an RDCore project: the folder that has the `.rdproj` file.

The [README]({REPOSITORY}#readme) covers the settings, the workspace and debugging.

### Verifying

```sh
sha256sum -c SHA256SUMS
gh attestation verify rdcore-vscode-{VERSION}.vsix -R {REPO} --signer-workflow {REPO}/.github/workflows/release.yml --source-ref {GITREF}
```

On macOS, `shasum -a 256 -c SHA256SUMS` checks the sum.

The `.vsix` is **not signed**.

### Source and licence

RDCore for VS Code is licensed under the GNU General Public License, version 3 or any later version. Its source is in [{REPO}]({REPOSITORY}).
