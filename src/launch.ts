// The launch contract of a deployed RDCore platform, restated from RDCore.SDK (RDCoreLanguageServerLaunch, RDCoreDebugAdapterLaunch,
// PlatformPipeName): which executable, which arguments, which environment, and which pipe. No VS Code API here, so the smoke script
// runs the very same code.

import { randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** The manifest's file name, at the platform root. */
export const ManifestFileName = "rdcore.json";

/** The environment variable that names the platform root to a process of the platform. */
export const PlatformRootEnvironmentVariable = "RDCORE_PLATFORM_ROOT";

/** The switch that starts the language server's executable as a debug adapter. */
export const DebugAdapterSwitch = "--dap";

/** The type of debug adapter, as the DAP initialize request's adapterID says it. */
export const DebugAdapterId = "rdcore";

/** Why a platform root can't be used: a message for the user. */
export class PlatformRootError extends Error {}

/** The start of a process of the platform. */
export interface ProcessLaunch {
    readonly platformRoot: string;
    readonly executable: string;
    readonly args: string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
}

/** The start of the language server, and the pipe it listens on. */
export interface LanguageServerLaunch extends ProcessLaunch {
    readonly pipeName: string;
}

interface PlatformManifest {
    langService?: string;
    hostService?: string;
    parseServer?: string;
}

/** A folder as the platform is given it: its absolute file: URI, with a trailing slash, escaped. */
export function folderUri(folder: string): string {
    const full = path.resolve(folder);
    return pathToFileURL(full.endsWith(path.sep) ? full : full + path.sep).href;
}

/** A new pipe name for a language server: rdc-ls-<12 random lowercase letters and digits>. */
export function newPipeName(): string {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    let random = "";
    for (let i = 0; i < 12; i++) {
        random += alphabet[randomInt(alphabet.length)];
    }
    return `rdc-ls-${random}`;
}

/** The path a client connects to for a pipe name: \\.\pipe\<name> on Windows, .NET's Unix domain socket elsewhere. */
export function pipePath(pipeName: string): string {
    return process.platform === "win32"
        ? `\\\\.\\pipe\\${pipeName}`
        : path.join(os.tmpdir(), `CoreFxPipe_${pipeName}`);
}

/** Reads the manifest of a platform root. */
export function readManifest(root: string): PlatformManifest {
    const file = path.join(root, ManifestFileName);
    if (!fs.existsSync(file)) {
        throw new PlatformRootError(`The platform root ${root} has no ${ManifestFileName}.`);
    }

    try {
        // a manifest written by PowerShell starts with a byte order mark.
        const json = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
        // the SDK reads the manifest without regard to the case of its property names.
        const byName = new Map(Object.entries(json).map(([key, value]) => [key.toLowerCase(), value]));
        const text = (name: string) => (typeof byName.get(name) === "string" ? (byName.get(name) as string) : undefined);
        return { langService: text("langservice"), hostService: text("hostservice"), parseServer: text("parseserver") };
    } catch (error) {
        throw new PlatformRootError(`${file} is not a platform manifest: ${(error as Error).message}`);
    }
}

/** The real path of the language server's executable the manifest names, under the platform root, with or without .exe. */
export function findLanguageServer(platformRoot: string): { root: string; executable: string } {
    const root = path.resolve(platformRoot);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new PlatformRootError(`The platform root ${root} does not exist.`);
    }

    const manifest = readManifest(root);
    if (!manifest.langService || manifest.langService.trim() === "") {
        throw new PlatformRootError(`The manifest of ${root} names no language server (langService).`);
    }

    const realRoot = fs.realpathSync.native(root);
    const named = path.join(root, manifest.langService.replace(/[\\/]/g, path.sep));
    const other = named.toLowerCase().endsWith(".exe") ? named.slice(0, -4) : named + ".exe";
    const found = [named, other].find(candidate => fs.existsSync(candidate));
    if (!found) {
        throw new PlatformRootError(`The language server the manifest of ${root} names is not there: ${named}.`);
    }

    const real = fs.realpathSync.native(found);
    const relative = path.relative(realRoot, real);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new PlatformRootError(`The manifest of ${root} names a language server outside the platform root: ${manifest.langService}.`);
    }

    return { root, executable: real };
}

function environment(root: string): NodeJS.ProcessEnv {
    return { ...process.env, [PlatformRootEnvironmentVariable]: root };
}

/** How to start the language server for a workspace folder: --pipe-name <pipe> --workspace <uri> [--client-process-id <pid>]. */
export function prepareLanguageServer(platformRoot: string, workspaceFolder: string, clientProcessId?: number): LanguageServerLaunch {
    const { root, executable } = findLanguageServer(platformRoot);
    const pipeName = newPipeName();
    const args = ["--pipe-name", pipeName, "--workspace", folderUri(workspaceFolder)];
    if (clientProcessId !== undefined) {
        args.push("--client-process-id", String(clientProcessId));
    }

    return { platformRoot: root, executable, args, cwd: path.dirname(executable), env: environment(root), pipeName };
}

/** How to start the debug adapter for a workspace folder: the language server's executable, with --dap --workspace <uri>. */
export function prepareDebugAdapter(platformRoot: string, workspaceFolder: string): ProcessLaunch {
    const { root, executable } = findLanguageServer(platformRoot);
    return {
        platformRoot: root,
        executable,
        args: [DebugAdapterSwitch, "--workspace", folderUri(workspaceFolder)],
        cwd: path.dirname(executable),
        env: environment(root),
    };
}

/**
 * Connects to the pipe the language server listens on, trying again until it is there: the server opens it once it has started.
 * Gives up when `gone` says the process ended, or after `timeoutMs`.
 */
export function connectToPipe(pipeName: string, options: { timeoutMs?: number; gone?: () => string | undefined } = {}): Promise<net.Socket> {
    const target = pipePath(pipeName);
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const ended = options.gone?.();
            if (ended !== undefined) {
                reject(new Error(`The language server ended before it opened its pipe: ${ended}`));
                return;
            }

            const socket = net.connect(target);
            socket.once("connect", () => {
                socket.removeAllListeners("error");
                resolve(socket);
            });
            socket.once("error", (error: NodeJS.ErrnoException) => {
                socket.destroy();
                if (Date.now() >= deadline) {
                    reject(new Error(`The language server's pipe ${target} could not be connected to: ${error.message}`));
                } else {
                    setTimeout(attempt, 100);
                }
            });
        };
        attempt();
    });
}

/** A folder of the workspace: its path, its name, and its index among the workspace's folders. */
export interface WorkspaceFolderEntry {
    readonly path: string;
    readonly name: string;
    readonly index: number;
}

/**
 * The folder the platform opens, for both of the ways the language server is told it: the --workspace argument, and the language
 * client's workspace folder, which the client sends as the initialize request's rootUri and its only workspace folder. It is the
 * folder of the first .rdproj (findProjectFolder), which can be below the opened folder that holds it, else the first opened folder.
 * The server loads the project of its rootUri, and starts the rest of the platform on --workspace (RDCore.SDK RDCoreClientApp sends
 * the --workspace folder as rootUri): both name this one folder. Its index is the opened folder's that holds it.
 */
export function projectWorkspaceFolder(opened: readonly WorkspaceFolderEntry[], maxDepth = 4): WorkspaceFolderEntry | undefined {
    const project = findProjectFolder(opened.map(folder => folder.path), maxDepth);
    if (project === undefined) {
        return opened[0];
    }

    const full = path.resolve(project);
    const holder = opened.find(folder => {
        const relative = path.relative(path.resolve(folder.path), full);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    return { path: full, name: path.basename(full), index: holder?.index ?? 0 };
}

/** The folder of the first .rdproj among the given folders: a folder's own, else the first found under it. */
export function findProjectFolder(folders: readonly string[], maxDepth = 4): string | undefined {
    for (const folder of folders) {
        if (fs.existsSync(path.join(folder, ".rdproj"))) {
            return folder;
        }
    }

    const skipped = new Set(["node_modules", ".git", "bin", "obj"]);
    const search = (folder: string, depth: number): string | undefined => {
        if (depth > maxDepth) {
            return undefined;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(folder, { withFileTypes: true });
        } catch {
            return undefined;
        }

        if (entries.some(entry => entry.isFile() && entry.name === ".rdproj")) {
            return folder;
        }

        for (const entry of entries) {
            if (entry.isDirectory() && !skipped.has(entry.name)) {
                const found = search(path.join(folder, entry.name), depth + 1);
                if (found) {
                    return found;
                }
            }
        }

        return undefined;
    };

    for (const folder of folders) {
        const found = search(folder, 0);
        if (found) {
            return found;
        }
    }

    return undefined;
}
