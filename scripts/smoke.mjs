// Starts a deployed RDCore platform with the extension's own launch code (out/launch.js, built by esbuild.mjs), and checks both
// protocols the extension speaks to it:
//   1. the language server: spawned, connected to over its pipe, `initialize`d; its capabilities (and any it registers after
//      `initialized`) are printed; the sample's two modules are opened and a few requests are sent, of which four are checked:
//      completion of a member of the workspace's class (greeter.Greet) and of the standard library's Debug object (Debug.Print),
//      and hover on a variable (greeter) and on a function of the standard library (CStr); then `shutdown` and `exit`.
//   2. the debug adapter: spawned with --dap, spoken to over stdin/stdout, `initialize`d; its capabilities are printed and
//      supportsConditionalBreakpoints checked; then the sample program is launched with a conditional breakpoint, and disconnected.
//
// node scripts/smoke.mjs [--platform-root <folder>] [--workspace <folder>]
// Defaults: the platform root in RDCORE_SMOKE_PLATFORM_ROOT, else C:\Dev\RDCore\artifacts\rdcore-dev; the workspace samples/hello.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const launch = require("../out/launch.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const option = name => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : undefined;
};
const platformRoot = option("--platform-root") ?? process.env.RDCORE_SMOKE_PLATFORM_ROOT ?? "C:\\Dev\\RDCore\\artifacts\\rdcore-dev";
const workspace = path.resolve(option("--workspace") ?? path.join(here, "..", "samples", "hello"));
const program = path.join(workspace, "src", "Program.bas");
const greeterClass = path.join(workspace, "src", "Greeter.cls");

const failures = [];
const started = [];

function log(text) {
    console.log(`[${new Date().toISOString().slice(11, 23)}] ${text}`);
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))),
    ]).finally(() => clearTimeout(timer));
}

// Content-Length framing, which LSP and DAP share.
class Framed {
    constructor(readable, writable, onMessage) {
        this.writable = writable;
        this.buffer = Buffer.alloc(0);
        readable.on("data", chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            for (;;) {
                const end = this.buffer.indexOf("\r\n\r\n");
                if (end < 0) return;
                const header = this.buffer.subarray(0, end).toString("ascii");
                const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
                if (this.buffer.length < end + 4 + length) return;
                const body = this.buffer.subarray(end + 4, end + 4 + length).toString("utf8");
                this.buffer = this.buffer.subarray(end + 4 + length);
                onMessage(JSON.parse(body));
            }
        });
    }

    send(message) {
        const body = Buffer.from(JSON.stringify(message), "utf8");
        this.writable.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.writable.write(body);
    }
}

function track(child, name) {
    const entry = { child, name, exit: new Promise(resolve => child.once("exit", (code, signal) => resolve(code ?? signal))) };
    started.push(entry);
    return entry;
}

async function ended(entry, ms) {
    try {
        const code = await withTimeout(entry.exit, ms, `${entry.name} exit`);
        log(`${entry.name} ended by itself, exit code ${code}.`);
    } catch {
        failures.push(`${entry.name} did not end within ${ms / 1000} s of being told to; it was killed.`);
        entry.child.kill();
        await entry.exit;
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------

const vscodeLikeCapabilities = {
    general: { positionEncodings: ["utf-16"], markdown: { parser: "marked", version: "1.1.0" } },
    window: { workDoneProgress: true, showMessage: { messageActionItem: { additionalPropertiesSupport: true } }, showDocument: { support: true } },
    workspace: {
        applyEdit: true,
        workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"], failureHandling: "textOnlyTransactional" },
        didChangeConfiguration: { dynamicRegistration: true },
        didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
        symbol: { dynamicRegistration: true },
        executeCommand: { dynamicRegistration: true },
        configuration: true,
        workspaceFolders: true,
        semanticTokens: { refreshSupport: true },
        codeLens: { refreshSupport: true },
        inlayHint: { refreshSupport: true },
        inlineValue: { refreshSupport: true },
        diagnostics: { refreshSupport: true },
        fileOperations: { dynamicRegistration: true, didCreate: true, didRename: true, didDelete: true, willCreate: true, willRename: true, willDelete: true },
    },
    textDocument: {
        synchronization: { dynamicRegistration: true, willSave: true, willSaveWaitUntil: true, didSave: true },
        completion: {
            dynamicRegistration: true,
            contextSupport: true,
            completionItem: {
                snippetSupport: true, commitCharactersSupport: true, documentationFormat: ["markdown", "plaintext"], deprecatedSupport: true,
                preselectSupport: true, tagSupport: { valueSet: [1] }, insertReplaceSupport: true,
                resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] }, labelDetailsSupport: true,
            },
            completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode", "data"] },
        },
        hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
        signatureHelp: {
            dynamicRegistration: true, contextSupport: true,
            signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
        },
        definition: { dynamicRegistration: true, linkSupport: true },
        declaration: { dynamicRegistration: true, linkSupport: true },
        typeDefinition: { dynamicRegistration: true, linkSupport: true },
        implementation: { dynamicRegistration: true, linkSupport: true },
        references: { dynamicRegistration: true },
        documentHighlight: { dynamicRegistration: true },
        documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true, labelSupport: true },
        codeAction: {
            dynamicRegistration: true, isPreferredSupport: true, disabledSupport: true, dataSupport: true, honorsChangeAnnotations: true,
            resolveSupport: { properties: ["edit"] },
            codeActionLiteralSupport: {
                codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] },
            },
        },
        codeLens: { dynamicRegistration: true },
        formatting: { dynamicRegistration: true },
        rangeFormatting: { dynamicRegistration: true, rangesSupport: true },
        onTypeFormatting: { dynamicRegistration: true },
        rename: { dynamicRegistration: true, prepareSupport: true, prepareSupportDefaultBehavior: 1, honorsChangeAnnotations: true },
        documentLink: { dynamicRegistration: true, tooltipSupport: true },
        publishDiagnostics: { relatedInformation: true, versionSupport: false, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true, dataSupport: true },
        foldingRange: { dynamicRegistration: true, rangeLimit: 5000, lineFoldingOnly: true, foldingRangeKind: { valueSet: ["comment", "imports", "region"] } },
        selectionRange: { dynamicRegistration: true },
        callHierarchy: { dynamicRegistration: true },
        typeHierarchy: { dynamicRegistration: true },
        semanticTokens: {
            dynamicRegistration: true,
            tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember",
                "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
            tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
            formats: ["relative"],
            requests: { range: true, full: { delta: true } },
            multilineTokenSupport: false, overlappingTokenSupport: false, serverCancelSupport: true, augmentsSyntaxTokens: true,
        },
        linkedEditingRange: { dynamicRegistration: true },
        inlayHint: { dynamicRegistration: true, resolveSupport: { properties: ["tooltip", "textEdits", "label.tooltip", "label.location", "label.command"] } },
        inlineValue: { dynamicRegistration: true },
        diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
    },
};

async function smokeLanguageServer() {
    section("Language server");
    const prepared = launch.prepareLanguageServer(platformRoot, workspace, process.pid);
    log(`spawn ${prepared.executable} ${prepared.args.join(" ")}`);
    log(`env ${launch.PlatformRootEnvironmentVariable}=${prepared.env[launch.PlatformRootEnvironmentVariable]}`);
    const child = spawn(prepared.executable, prepared.args, { cwd: prepared.cwd, env: prepared.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const entry = track(child, "language server");
    let gone;
    let stderr = "";
    child.on("error", error => (gone = error.message));
    child.once("exit", code => (gone ??= `exit code ${code}; stderr: ${stderr.slice(-2000)}`));
    child.stdout.resume();
    child.stderr.on("data", data => (stderr += data.toString()));
    log(`pid ${child.pid}; connecting to ${launch.pipePath(prepared.pipeName)}`);

    const socket = await launch.connectToPipe(prepared.pipeName, { timeoutMs: 120_000, gone: () => gone });
    log("connected to the pipe.");

    let nextId = 1;
    const pending = new Map();
    const registrations = [];
    const diagnostics = new Map();
    const notifications = new Map();
    const connection = new Framed(socket, socket, message => {
        if (message.id !== undefined && message.method === undefined) {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
            return;
        }

        if (message.id !== undefined) {
            // a request of the server's.
            let result = null;
            if (message.method === "client/registerCapability") {
                registrations.push(...(message.params?.registrations ?? []));
            } else if (message.method === "workspace/configuration") {
                result = (message.params?.items ?? []).map(() => null);
            } else if (message.method === "workspace/workspaceFolders") {
                result = [{ uri: launch.folderUri(workspace), name: path.basename(workspace) }];
            }
            connection.send({ jsonrpc: "2.0", id: message.id, result });
            return;
        }

        notifications.set(message.method, (notifications.get(message.method) ?? 0) + 1);
        if (message.method === "textDocument/publishDiagnostics") {
            diagnostics.set(message.params.uri, message.params.diagnostics);
        }
    });

    const request = (method, params, ms = 120_000) => {
        const id = nextId++;
        const answer = new Promise(resolve => pending.set(id, resolve));
        connection.send({ jsonrpc: "2.0", id, method, params });
        return withTimeout(answer, ms, method);
    };
    const notify = (method, params) => connection.send({ jsonrpc: "2.0", method, params });

    const t0 = Date.now();
    const initialize = await request("initialize", {
        processId: process.pid,
        clientInfo: { name: "rdcore-vscode smoke", version: "0.1.0" },
        locale: "en",
        rootPath: workspace,
        rootUri: launch.folderUri(workspace),
        workspaceFolders: [{ uri: launch.folderUri(workspace), name: path.basename(workspace) }],
        capabilities: vscodeLikeCapabilities,
        trace: "off",
    });
    if (initialize.error) {
        failures.push(`LSP initialize failed: ${JSON.stringify(initialize.error)}`);
        return entry;
    }

    log(`initialize answered in ${Date.now() - t0} ms. serverInfo: ${JSON.stringify(initialize.result.serverInfo ?? null)}`);
    console.log("LSP server capabilities:");
    console.log(JSON.stringify(initialize.result.capabilities, null, 2));
    notify("initialized", {});

    // the sample's modules opened, and the requests an editor sends for them.
    const { readFileSync } = await import("node:fs");
    const opened = new Map();
    for (const file of [program, greeterClass]) {
        const text = readFileSync(file, "utf8");
        const fileUri = pathToFileURL(file).href;
        opened.set(file, { uri: fileUri, text });
        notify("textDocument/didOpen", { textDocument: { uri: fileUri, languageId: "vba", version: 1, text } });
    }

    const uri = opened.get(program).uri;
    const lineCount = opened.get(program).text.split("\n").length;
    let lenses = [];
    const probes = [
        ["textDocument/documentSymbol", { textDocument: { uri } }, result => `${result?.length ?? 0} symbols`],
        ["textDocument/semanticTokens/full", { textDocument: { uri } }, result => `${(result?.data?.length ?? 0) / 5} tokens`],
        ["textDocument/foldingRange", { textDocument: { uri } }, result => `${result?.length ?? 0} ranges`],
        ["textDocument/codeLens", { textDocument: { uri } }, result => ((lenses = result ?? []), `${lenses.length} lenses`)],
        ["textDocument/inlayHint", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: lineCount, character: 0 } } },
            result => `${result?.length ?? 0} hints`],
    ];
    for (const [method, params, describe] of probes) {
        try {
            const answer = await request(method, params, 60_000);
            log(`${method}: ${answer.error ? `error ${JSON.stringify(answer.error)}` : describe(answer.result)}`);
        } catch (error) {
            log(`${method}: ${error.message}`);
        }
    }

    // the checked requests, each at a place in the sample found by its text, so an edit of the sample moves them with it: the
    // position just after `after` in the first occurrence of `text` in the file.
    const at = (file, text, after) => {
        const { uri: fileUri, text: source } = opened.get(file);
        const offset = source.indexOf(text);
        if (offset < 0) {
            throw new Error(`${path.basename(file)} has no "${text}": the smoke checks need the sample as it was written for them.`);
        }

        const before = source.slice(0, offset + after.length).split("\n");
        return { textDocument: { uri: fileUri }, position: { line: before.length - 1, character: before.at(-1).length } };
    };
    const labelsOf = result => (Array.isArray(result) ? result : result?.items ?? []).map(item => item.label);
    const hoverText = result => {
        const contents = result?.contents;
        const parts = Array.isArray(contents) ? contents : [contents];
        return parts.map(part => (typeof part === "string" ? part : part?.value ?? "")).join("\n");
    };
    const invoked = { triggerKind: 2, triggerCharacter: "." };
    const checks = [
        ["completion of a member of the workspace's class", "textDocument/completion", { ...at(program, "greeter.Greet(", "greeter."), context: invoked },
            result => labelsOf(result).includes("Greet") || `no Greet among ${JSON.stringify(labelsOf(result))}`],
        ["completion of a member of the standard library's Debug object", "textDocument/completion",
            { ...at(program, "Debug.Print", "Debug."), context: invoked },
            result => labelsOf(result).includes("Print") || `no Print among ${JSON.stringify(labelsOf(result))}`],
        ["hover on a variable", "textDocument/hover", at(program, "greeter.Greet(", "gr"),
            result => /\bgreeter As Greeter\b/.test(hoverText(result)) || `the hover is ${JSON.stringify(hoverText(result))}`],
        ["hover on a function of the standard library", "textDocument/hover", at(greeterClass, "CStr(times)", "CS"),
            result => (/\bCStr\b/.test(hoverText(result)) && /\bVBA\./.test(hoverText(result))) || `the hover is ${JSON.stringify(hoverText(result))}`],
    ];
    for (const [what, method, params, check] of checks) {
        try {
            const answer = await request(method, params, 60_000);
            const verdict = answer.error ? `error ${JSON.stringify(answer.error)}` : check(answer.result);
            log(`${what} (${method} at ${params.position.line}:${params.position.character}): ${verdict === true ? "ok" : verdict}`);
            if (verdict !== true) {
                failures.push(`${what}: ${verdict}`);
            }
        } catch (error) {
            failures.push(`${what}: ${error.message}`);
        }
    }

    for (const lens of lenses) {
        const resolved = lens.command ? { result: lens } : await request("codeLens/resolve", lens, 60_000);
        log(`codeLens/resolve: ${JSON.stringify(resolved.result?.command ?? resolved.error)}`);
    }

    // what the server registers after initialized, and the diagnostics it publishes, given a moment.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    console.log(`Registered after initialized (${registrations.length}): ${JSON.stringify(registrations.map(registration => registration.method))}`);
    for (const registration of registrations.filter(item => ["workspace/executeCommand", "textDocument/semanticTokens"].includes(item.method))) {
        console.log(`  ${registration.method}: ${JSON.stringify(registration.registerOptions)}`);
    }
    console.log(`Notifications from the server: ${JSON.stringify(Object.fromEntries(notifications))}`);
    for (const [document, list] of diagnostics) {
        console.log(`Diagnostics for ${path.basename(fileURLToPath(document))}: ${list.length} ${JSON.stringify(list.map(item => item.code))}`);
    }

    const shutdown = await request("shutdown", null, 60_000);
    log(`shutdown answered: ${shutdown.error ? JSON.stringify(shutdown.error) : "null (ok)"}`);
    notify("exit", null);
    await ended(entry, 30_000);
    socket.destroy();
    return entry;
}

// ---------------------------------------------------------------------------------------------------------------------------------

async function smokeDebugAdapter() {
    section("Debug adapter");
    const prepared = launch.prepareDebugAdapter(platformRoot, workspace);
    log(`spawn ${prepared.executable} ${prepared.args.join(" ")}`);
    const child = spawn(prepared.executable, prepared.args, { cwd: prepared.cwd, env: prepared.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const entry = track(child, "debug adapter");
    let stderr = "";
    child.stderr.on("data", data => (stderr += data.toString()));
    log(`pid ${child.pid}`);

    let seq = 1;
    const pending = new Map();
    const events = [];
    const waiters = [];
    const connection = new Framed(child.stdout, child.stdin, message => {
        if (message.type === "response") {
            pending.get(message.request_seq)?.(message);
            pending.delete(message.request_seq);
        } else if (message.type === "event") {
            events.push(message);
            if (message.event === "output") {
                log(`output (${message.body?.category ?? "console"}): ${String(message.body?.output ?? "").trimEnd()}`);
            }
            for (const waiter of [...waiters]) {
                if (waiter.event === message.event) {
                    waiters.splice(waiters.indexOf(waiter), 1);
                    waiter.resolve(message);
                }
            }
        } else if (message.type === "request") {
            connection.send({ seq: seq++, type: "response", request_seq: message.seq, command: message.command, success: true });
        }
    });
    const request = (command, args, ms = 120_000) => {
        const id = seq++;
        const answer = new Promise(resolve => pending.set(id, resolve));
        connection.send({ seq: id, type: "request", command, arguments: args });
        return withTimeout(answer, ms, `DAP ${command}`);
    };
    const event = (name, ms = 120_000) => {
        const seen = events.find(item => item.event === name && !item.taken);
        if (seen) {
            seen.taken = true;
            return Promise.resolve(seen);
        }
        return withTimeout(new Promise(resolve => waiters.push({ event: name, resolve: message => ((message.taken = true), resolve(message)) })), ms, `DAP event ${name}`);
    };

    const t0 = Date.now();
    const initialize = await request("initialize", {
        clientID: "vscode", clientName: "rdcore-vscode smoke", adapterID: launch.DebugAdapterId, locale: "en",
        linesStartAt1: true, columnsStartAt1: true, pathFormat: "path",
        supportsVariableType: true, supportsVariablePaging: true, supportsRunInTerminalRequest: false, supportsMemoryReferences: true,
        supportsProgressReporting: true, supportsInvalidatedEvent: true, supportsMemoryEvent: true, supportsArgsCanBeInterpretedByShell: true,
        supportsStartDebuggingRequest: true,
    });
    if (!initialize.success) {
        failures.push(`DAP initialize failed: ${initialize.message}; stderr: ${stderr.slice(-2000)}`);
    } else {
        log(`initialize answered in ${Date.now() - t0} ms.`);
        console.log("DAP capabilities:");
        console.log(JSON.stringify(initialize.body, null, 2));
        console.log(`supportsConditionalBreakpoints: ${initialize.body?.supportsConditionalBreakpoints === true}`);
        if (initialize.body?.supportsConditionalBreakpoints !== true) {
            failures.push("The debug adapter does not advertise supportsConditionalBreakpoints.");
        }

        // the sample run, as VS Code runs it: launch, initialized, breakpoints, configurationDone; a stop where the condition holds.
        try {
            // the module is named: a platform built before 2026-11 refuses a launch that names none.
            const launched = request("launch", { type: "rdcore", request: "launch", name: "smoke", module: "Program", entryPoint: "Main" });
            await event("initialized");
            const breakpoints = await request("setBreakpoints", {
                source: { path: program, name: path.basename(program) },
                breakpoints: [{ line: 9, condition: "i = 2" }],
                sourceModified: false,
            });
            log(`setBreakpoints: ${JSON.stringify(breakpoints.body?.breakpoints ?? breakpoints.message)}`);
            await request("setExceptionBreakpoints", { filters: [] });
            await request("configurationDone", {});
            const launchAnswer = await launched;
            log(`launch: ${launchAnswer.success ? "ok" : `refused: ${launchAnswer.message}`}`);
            if (launchAnswer.success) {
                const stopped = await event("stopped", 120_000);
                log(`stopped: ${JSON.stringify(stopped.body)}`);
                const frames = await request("stackTrace", { threadId: stopped.body.threadId ?? 1 });
                const top = frames.body?.stackFrames?.[0];
                log(`top frame: ${top?.name} at line ${top?.line}`);
                const value = await request("evaluate", { expression: "i", frameId: top?.id, context: "watch" });
                log(`evaluate i: ${value.success ? value.body?.result : value.message}`);
                if (value.success && String(value.body?.result).trim() !== "2") {
                    failures.push(`The conditional breakpoint (i = 2) stopped with i = ${value.body?.result}.`);
                }
                await request("continue", { threadId: stopped.body.threadId ?? 1 });
                await event("terminated", 60_000);
                log("terminated.");
            } else {
                failures.push(`DAP launch refused: ${launchAnswer.message}`);
            }
        } catch (error) {
            failures.push(`DAP launch run: ${error.message}`);
        }
    }

    try {
        const disconnect = await request("disconnect", { terminateDebuggee: true }, 30_000);
        log(`disconnect: ${disconnect.success ? "ok" : disconnect.message}`);
    } catch (error) {
        log(`disconnect: ${error.message}`);
    }
    child.stdin.end();
    await ended(entry, 30_000);
    return entry;
}

// ---------------------------------------------------------------------------------------------------------------------------------

log(`platform root ${platformRoot}`);
log(`workspace ${workspace}`);
try {
    await smokeLanguageServer();
} catch (error) {
    failures.push(`language server: ${error.message}`);
}
try {
    await smokeDebugAdapter();
} catch (error) {
    failures.push(`debug adapter: ${error.message}`);
}

// nothing of the script's own outlives it.
for (const entry of started) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
        log(`killing ${entry.name} (pid ${entry.child.pid}), still running.`);
        entry.child.kill();
    }
}

section("Result");
if (failures.length === 0) {
    console.log("OK: both initialize round trips done, completion and hover checked, both processes ended.");
} else {
    for (const failure of failures) {
        console.log(`FAILED: ${failure}`);
    }
    process.exitCode = 1;
}
