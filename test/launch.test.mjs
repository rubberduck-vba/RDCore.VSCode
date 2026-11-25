// The launch code as the extension runs it (out/launch.js, built by esbuild.mjs): node --test test/
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const launch = require("../out/launch.js");
const here = path.dirname(fileURLToPath(import.meta.url));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rdcore-vscode-test-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// an opened folder that holds a project folder with an .rdproj, at the depth given (0: the opened folder is the project folder).
function openedFolder(name, depth) {
    const opened = path.join(scratch, name);
    const project = depth === 0 ? opened : path.join(opened, ...Array.from({ length: depth }, (_, level) => `level${level}`), "hello");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, ".rdproj"), "{}");
    return { opened, project };
}

test("vscode-languageclient sends the initialize rootUri and workspace folder of clientOptions.workspaceFolder", () => {
    // the premise of the test below: the client's rootUri is the workspace folder the extension gives it. If this fails, the client
    // takes its root from elsewhere now, and what the extension gives it must be checked again.
    const client = fs.readFileSync(path.join(here, "..", "node_modules", "vscode-languageclient", "lib", "common", "client.js"), "utf8");
    assert.match(client, /this\._clientOptions\.workspaceFolder\.uri\.fsPath/);
});

test("a project folder below the opened folder is the client's workspace folder, with the opened folder's index", () => {
    const other = openedFolder("other-without-project", 0);
    fs.rmSync(path.join(other.project, ".rdproj"));
    const { opened, project } = openedFolder("opened", 2);

    const folder = launch.projectWorkspaceFolder([
        { path: other.opened, name: "other-without-project", index: 0 },
        { path: opened, name: "opened", index: 1 },
    ]);

    assert.deepEqual(folder, { path: project, name: "hello", index: 1 });
    // and --workspace names the same folder.
    assert.equal(launch.folderUri(folder.path), launch.folderUri(project));
});

test("an opened folder that is the project folder is the client's workspace folder", () => {
    const { opened } = openedFolder("project-at-top", 0);

    const folder = launch.projectWorkspaceFolder([{ path: opened, name: "project-at-top", index: 0 }]);

    assert.deepEqual(folder, { path: opened, name: "project-at-top", index: 0 });
});
