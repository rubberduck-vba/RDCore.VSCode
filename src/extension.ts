import { ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    Location as LspLocation,
    Position as LspPosition,
    Range as LspRange,
    ServerOptions,
    StreamInfo,
} from "vscode-languageclient/node";
import {
    DebugAdapterId,
    PlatformRootError,
    connectToPipe,
    findProjectFolder,
    prepareDebugAdapter,
    prepareLanguageServer,
} from "./launch";

const ClientId = "rdcore";
const ClientName = "RDCore";

// the modules of RD-VBA and VB6 projects (RDCore.SDK SupportedLanguages.RDVBA and VB6, ModuleFileTypes), as package.json names them.
const ModuleExtensions = ["bas", "cls", "frm", "ctl", "pag", "dob", "doccls", "rdform"];

let client: LanguageClient | undefined;
let server: ChildProcess | undefined;
let output: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    output = vscode.window.createOutputChannel(ClientName, { log: true });
    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.commands.registerCommand("rdcore.restartServer", () => restart()),
        // the commands of the server's code actions and code lenses that the client runs itself (RDCore.SDK RefactoringCommands).
        vscode.commands.registerCommand("rdcore.rename", rename),
        vscode.commands.registerCommand("rdcore.showReferences", showReferences),
        vscode.commands.registerCommand("rdcore.goToLocation", goToLocation),
        vscode.debug.registerDebugAdapterDescriptorFactory(DebugAdapterId, new DebugAdapterFactory()),
        vscode.debug.registerDebugConfigurationProvider(DebugAdapterId, new DebugConfigurations()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("rdcore.platformRoot")) {
                void restart();
            }
        }),
    );

    await start();
}

export async function deactivate(): Promise<void> {
    await stop();
}

// the platform root the user set, or nothing, after telling them it is missing.
function platformRoot(): string | undefined {
    const root = vscode.workspace.getConfiguration("rdcore").get<string>("platformRoot")?.trim();
    if (!root) {
        void tellToOpenSettings("RDCore: set rdcore.platformRoot to the folder of a deployed RDCore platform (the folder of its rdcore.json).");
        return undefined;
    }

    return root;
}

async function tellToOpenSettings(message: string): Promise<void> {
    const open = "Open Settings";
    if ((await vscode.window.showErrorMessage(message, open)) === open) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "rdcore.platformRoot");
    }
}

function workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file").map(folder => folder.uri.fsPath);
}

// the workspace the platform opens: the folder of the workspace's .rdproj, else the first workspace folder.
function projectFolder(): string | undefined {
    const folders = workspaceFolders();
    return findProjectFolder(folders) ?? folders[0];
}

async function start(): Promise<void> {
    const root = platformRoot();
    const workspace = projectFolder();
    if (!root) {
        return;
    }

    if (!workspace) {
        void vscode.window.showWarningMessage("RDCore: open the folder of an RDCore project (.rdproj) to start the language server.");
        return;
    }

    // checked here, so a platform root that can't be used is said once, plainly, instead of as a failed start.
    try {
        prepareLanguageServer(root, workspace);
    } catch (error) {
        if (error instanceof PlatformRootError) {
            void tellToOpenSettings(`RDCore: ${error.message}`);
            return;
        }
        throw error;
    }

    const serverOptions: ServerOptions = () => startServer(root, workspace);
    const clientOptions: LanguageClientOptions = {
        // a module is served by its file too: VS Code's own Visual Basic (vb) and TeX languages claim .bas and .cls, and a user
        // may associate a module to another language.
        documentSelector: [
            { scheme: "file", language: "vba" },
            { scheme: "file", pattern: `**/*.{${ModuleExtensions.join(",")}}` },
        ],
        outputChannel: output,
        workspaceFolder: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspace)),
    };

    client = new LanguageClient(ClientId, ClientName, serverOptions, clientOptions);
    try {
        await client.start();
    } catch (error) {
        output.appendLine(`The language server did not start: ${(error as Error).message}`);
        void vscode.window.showErrorMessage(`RDCore: the language server did not start: ${(error as Error).message}`);
    }
}

// the language server listens on a pipe and the client connects to it (RDCore.SDK RDCoreLanguageServerLaunch): VS Code's own pipe
// transport has the roles the other way around.
async function startServer(root: string, workspace: string): Promise<StreamInfo> {
    const launch = prepareLanguageServer(root, workspace, process.pid);
    output.appendLine(`Starting ${launch.executable} ${launch.args.join(" ")}`);
    const child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    server = child;

    let ended: string | undefined;
    child.on("error", error => (ended = error.message));
    child.on("exit", (code, signal) => {
        ended = `exit code ${code ?? signal}`;
        output.appendLine(`The language server ended (${ended}).`);
        if (server === child) {
            server = undefined;
        }
    });
    child.stdout?.on("data", (data: Buffer) => output.append(data.toString()));
    child.stderr?.on("data", (data: Buffer) => output.append(data.toString()));

    const socket = await connectToPipe(launch.pipeName, { gone: () => ended });
    return { reader: socket, writer: socket };
}

async function stop(): Promise<void> {
    const current = client;
    client = undefined;
    if (current) {
        try {
            await current.stop(10_000);
        } catch (error) {
            output.appendLine(`The language server did not stop cleanly: ${(error as Error).message}`);
        }
    }

    // the server ends on exit, and with the client's process; one that is still there after a grace period is ended.
    const child = server;
    if (child && child.exitCode === null) {
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                child.kill();
                resolve();
            }, 5_000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

async function restart(): Promise<void> {
    await stop();
    await start();
}

function uriOf(text: string): vscode.Uri {
    return client?.protocol2CodeConverter.asUri(text) ?? vscode.Uri.parse(text);
}

function positionOf(position: LspPosition): vscode.Position {
    return new vscode.Position(position.line, position.character);
}

function rangeOf(range: LspRange): vscode.Range {
    return new vscode.Range(positionOf(range.start), positionOf(range.end));
}

// rdcore.rename [uri, position]: VS Code's rename, at the position.
async function rename(uri: string, position: LspPosition): Promise<void> {
    const at = positionOf(position);
    await vscode.window.showTextDocument(uriOf(uri), { selection: new vscode.Range(at, at) });
    await vscode.commands.executeCommand("editor.action.rename");
}

// rdcore.showReferences [uri, position, locations]: the arguments of VS Code's editor.action.showReferences.
async function showReferences(uri: string, position: LspPosition, locations: LspLocation[]): Promise<void> {
    await vscode.commands.executeCommand(
        "editor.action.showReferences",
        uriOf(uri),
        positionOf(position),
        (locations ?? []).map(location => new vscode.Location(uriOf(location.uri), rangeOf(location.range))),
    );
}

// rdcore.goToLocation [uri, range]: the document, with the range selected.
async function goToLocation(uri: string, range: LspRange): Promise<void> {
    await vscode.window.showTextDocument(uriOf(uri), { selection: rangeOf(range) });
}

// the debug adapter is the language server's executable, started with --dap, speaking DAP over its standard input and output.
class DebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const root = platformRoot();
        const folders = session.workspaceFolder?.uri.scheme === "file" ? [session.workspaceFolder.uri.fsPath] : workspaceFolders();
        const workspace = findProjectFolder(folders) ?? folders[0];
        if (!root) {
            throw new Error("rdcore.platformRoot is not set.");
        }
        if (!workspace) {
            throw new Error("Open the folder of an RDCore project (.rdproj) to debug it.");
        }

        const launch = prepareDebugAdapter(root, workspace);
        output.appendLine(`Starting the debug adapter: ${launch.executable} ${launch.args.join(" ")}`);
        return new vscode.DebugAdapterExecutable(launch.executable, launch.args, { cwd: launch.cwd, env: stringsOnly(launch.env) });
    }
}

function stringsOnly(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

// F5 with no launch.json runs the program from its entry point.
class DebugConfigurations implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration {
        if (!config.type && !config.request && !config.name) {
            return { type: DebugAdapterId, request: "launch", name: "Run the program (RDCore)" };
        }

        return config;
    }
}
