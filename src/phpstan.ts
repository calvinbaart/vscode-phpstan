import { ICheckResult, handleDiagnosticErrors, globAsync, waitFor } from "./utils";
import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as tmp from "tmp";

import {
    workspace,
    window,
    TextDocument,
    languages,
    DiagnosticCollection,
    StatusBarItem,
    StatusBarAlignment,
    Uri,
    commands,
    Disposable,
    DiagnosticSeverity
} from "vscode";
import * as glob from "glob";

interface IExtensionConfig {
    path: string | null;
    level: string;
    memoryLimit: string;
    options: string[],
    enabled: boolean,
    projectFile: string
    excludeFiles: string[];
}

export class PHPStan {
    private _current: { [key: string]: child_process.ChildProcess };
    private _timeouts: { [key: string]: NodeJS.Timer };
    private _errors: { [key: string]: any };
    private _documents: { [key: string]: TextDocument };
    private _command: Disposable;

    private _binaryPath: string | null;
    private _config: IExtensionConfig;
    private _diagnosticCollection: DiagnosticCollection;
    private _statusBarItem: StatusBarItem;
    private _numActive: number;
    private _numQueued: number;

    constructor(config: IExtensionConfig) {
        this._current = {};
        this._timeouts = {};
        this._errors = {};
        this._documents = {};

        this._binaryPath = config.path;
        this._config = config;
        this._diagnosticCollection = languages.createDiagnosticCollection("error");
        this._statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
        this._numActive = 0;
        this._numQueued = 0;

        this._command = commands.registerCommand("extension.scanForErrors", (file) => {
            const path = file["fsPath"];

            if (fs.lstatSync(path).isDirectory()) {
                this.scanDirectory(path);
                return;
            }

            this.scanPath(path);
        });

        this.findBinaryPath();
    }

    /**
     * Filesystem method to find PHPStan
     */
    public findPHPStan() {
        const executableName = "phpstan" + (process.platform === "win32" ? ".bat" : "");
        const vendor = "vendor/bin/" + executableName;
        const paths = [];

        for (const folder of workspace.workspaceFolders) {
            paths.push(path.join(folder.uri.fsPath, vendor));
        }

        if (process.env.COMPOSER_HOME !== undefined) {
            paths.push(path.join(process.env.COMPOSER_HOME, vendor));
        } else {
            if (process.platform === "win32") {
                paths.push(path.join(process.env.USERPROFILE, "AppData/Roaming/composer", vendor));
            } else {
                paths.push(path.join(process.env.HOME, ".composer", vendor))
            }
        }

        const globalPaths = process.env.PATH.split(path.delimiter);
        for (const globalPath of globalPaths) {
            paths.push(globalPath + path.sep + executableName);
        }

        for (const path of paths) {
            if (fs.existsSync(path)) {
                // Check if we have permission to execute this file
                try {
                    fs.accessSync(path, fs.constants.X_OK);
                    this._binaryPath = path;
                    break;
                } catch (exception) {
                    continue;
                }
            }
        }
    }

    /**
     * This is where the magic happens. This method calls the PHPStan executable,
     * parses the errors and outputs them to VSCode.
     *
     * @param updatedDocument The document to re-scan
     */
    public async updateDocument(updatedDocument: TextDocument) {
        if (this._binaryPath === null || !this._config.enabled) {
            this.hideStatusBar();
            return;
        }

        if (updatedDocument.languageId !== "php") {
            this.hideStatusBar();
            return;
        }

        if (this._current[updatedDocument.fileName] !== undefined) {
            this._current[updatedDocument.fileName].kill();
            delete this._current[updatedDocument.fileName];
        }

        let autoload = [];
        let project = [];

        const workspaceFolder = workspace.getWorkspaceFolder(updatedDocument.uri);

        if (workspaceFolder) {
            const workspacefolderPath = workspaceFolder.uri.fsPath;
            const autoloadfile = path.join(workspacefolderPath, "vendor/autoload.php");

            if (fs.existsSync(autoloadfile)) {
                autoload.push(`--autoload-file=${autoloadfile}`);
            }
        }

        if (await this.isExcluded(updatedDocument)) {
            return;
        }

        if (this._config.projectFile !== null) {
            project.push("-c");
            project.push(this._config.projectFile);
        } else if (workspaceFolder) {
            const files = ["phpstan.neon", "phpstan.neon.dist"];

            for (const file of files) {
                if (fs.existsSync(path.join(workspaceFolder.uri.fsPath, file))) {
                    project.push("-c");
                    project.push(path.join(workspaceFolder.uri.fsPath, file));

                    break;
                }
            }
        }

        if (this._timeouts[updatedDocument.fileName] !== undefined) {
            clearTimeout(this._timeouts[updatedDocument.fileName]);
        }

        this._timeouts[updatedDocument.fileName] = setTimeout(async () => {
            delete this._timeouts[updatedDocument.fileName];

            let result: tmp.SynchrounousResult = null;
            let filePath: string = updatedDocument.fileName;

            if (updatedDocument.isDirty) {
                result = tmp.fileSync();
                fs.writeSync(result.fd, updatedDocument.getText());

                filePath = result.name;
            }

            if (this._errors[updatedDocument.fileName] === undefined) {
                this._errors[updatedDocument.fileName] = [{
                    file: updatedDocument.fileName,
                    line: 1,
                    msg: `[phpstan] queued for scanning`,
                    type: DiagnosticSeverity.Information
                }];
                this._documents[updatedDocument.fileName] = updatedDocument;
            }

            this._numQueued++;

            // PHPStan doesn't like running parallel so just lock it to 1 instance now:
            // https://github.com/phpstan/phpstan/issues/934
            await waitFor(() => {
                if (this._numActive !== 0) {
                    return false;
                }

                this._numActive++;
                return true;
            });

            let options = {};

            if (workspaceFolder) {
                options["cwd"] = workspaceFolder.uri.fsPath;
            }

            this._numQueued--;
            this._current[updatedDocument.fileName] = child_process.spawn(this._binaryPath, [
                "analyse",
                `--level=${this._config.level}`,
                ...autoload,
                ...project,
                "--error-format=raw",
                `--memory-limit=${this._config.memoryLimit}`,
                ...this._config.options,
                filePath
            ], options);

            let results: string = "";
            this._current[updatedDocument.fileName].stdout.on("data", (data) => {
                if (data instanceof Buffer) {
                    data = data.toString("utf8");
                }

                results += data;
            });

            this._current[updatedDocument.fileName].on("error", (err) => {
                if (err.message.indexOf("ENOENT") !== -1) {
                    window.showErrorMessage("[phpstan] Failed to find phpstan, the given path doesn't exist.");

                    this._binaryPath = null;
                }
            });

            this._statusBarItem.text = "[PHPStan] processing...";
            this._statusBarItem.show();

            this._current[updatedDocument.fileName].on("exit", (code) => {
                this._numActive--;

                if (result !== null) {
                    result.removeCallback();
                }

                if (code !== 1) {
                    const data: any[] = results.split("\n")
                        .map(x => x.trim())
                        .filter(x => !x.startsWith("!") && x.trim().length !== 0)
                        // .filter(x => x.startsWith("Warning:") || x.startsWith("Fatal error:"))
                        .map(x => {
                            if (x.startsWith("Warning:")) {
                                const message = x.substr("Warning:".length).trim();

                                return {
                                    message,
                                    type: "warning"
                                };
                            }

                            if (x.startsWith("Fatal error:")) {
                                const message = x.substr("Fatal error:".length).trim();

                                return {
                                    message,
                                    type: "error"
                                };
                            }

                            const message = x.trim();

                            return {
                                message,
                                type: "info"
                            };
                        });

                    for (const error of data) {
                        switch (error.type) {
                            case "warning":
                                window.showWarningMessage(`[phpstan] ${error.message}`);
                                break;

                            case "error":
                                window.showErrorMessage(`[phpstan] ${error.message}`);
                                break;

                            case "info":
                                window.showInformationMessage(`[phpstan] ${error.message}`);
                                break;
                        }
                    }

                    delete this._current[updatedDocument.fileName];
                    this.hideStatusBar();

                    if (data.length > 0) {
                        console.log(results);
                        return;
                    }
                }

                let autoloadError = false;
                const data: ICheckResult[] = results
                    .split("\n")
                    .map(x => x.substr(filePath.length + 1).trim())
                    .filter(x => x.length > 0)
                    .map(x => x.split(":"))
                    .map(x => {
                        let line = Number(x[0]);
                        x.shift();

                        // line 0 is not allowed so we need to start at 1
                        if (line === 0) {
                            line++;
                        }

                        let error = x.join(":");

                        // Only show this error once
                        if (error.indexOf("not found while trying to analyse it") !== -1) {
                            if (autoloadError) {
                                return null;
                            }

                            error = "File probably not autoloaded correctly, some analysis is unavailable.";
                            line = 1;

                            autoloadError = true;
                        }

                        return {
                            file: updatedDocument.fileName,
                            line: line,
                            msg: `[phpstan] ${error}`
                        };
                    })
                    .filter(x => x !== null && !isNaN(x.line));

                this._errors[updatedDocument.fileName] = data;
                this._documents[updatedDocument.fileName] = updatedDocument;

                let documents = Object.values(this._documents);
                let errors = [].concat.apply([], Object.values(this._errors));

                this.diagnosticCollection.clear();
                handleDiagnosticErrors(documents, errors, this._diagnosticCollection);

                this.hideStatusBar();
            });
        }, 300);
    }

    /**
     * Cleans up everything this extension created
     */
    dispose() {
        for (let key in this._current) {
            if (this._current[key].killed) {
                continue;
            }

            this._current[key].kill();
        }

        this._diagnosticCollection.dispose();
        this._command.dispose();
    }

    /**
     * Scans the file located at path
     * @param path File path to scan
     */
    public scanPath(path: string) {
        const documents = workspace.textDocuments;

        let found = false;

        for (const document of documents) {
            if (document.fileName === path) {
                this.updateDocument(document);
                found = true;

                break;
            }
        }

        if (found) {
            return;
        }

        workspace.openTextDocument(path);
    }

    /**
     * Scans all the files recursively in the directory
     * @param basePath Directory path to scan
     */
    public async scanDirectory(basePath: string) {
        // TODO: Change the code to make sure PHPStan iterates the directories instead of us

        const workspaceFolder = workspace.getWorkspaceFolder(Uri.file(basePath));
        let excludes = this._config.excludeFiles;

        if (workspaceFolder) {
            let workspaceDir = workspaceFolder.uri.fsPath;

            excludes = excludes.map(x => path.join(workspaceDir, x));
        }

        const files = await globAsync(basePath + path.sep + "**/*.php", {
            ignore: excludes
        });

        for (const file of files) {
            this.scanPath(file);
        }
    }

    /**
     * Checks if the document is in the exclude list
     * @param document Document to check
     */
    private async isExcluded(document: TextDocument): Promise<boolean>
    {
        const workspaceFolder = workspace.getWorkspaceFolder(document.uri);
        let excludes = this._config.excludeFiles;

        if (workspaceFolder) {
            let workspaceDir = workspaceFolder.uri.fsPath;

            excludes = excludes.map(x => path.join(workspaceDir, x));
        }

        const data = await Promise.all(excludes.map(x => globAsync(x, {})));
        const merged: string[] = [].concat.apply([], data);
        const unique = merged.filter((elem, pos, arr) => {
            return arr.indexOf(elem) == pos;
        });

        return unique.indexOf(document.uri.fsPath) !== -1;
    }

    /**
     * Hides the statusbar if there are no active items
     */
    private hideStatusBar() {
        if (this._numActive === 0 && this._numQueued === 0) {
            this._statusBarItem.hide();
        }
    }

    /**
     * Determines the location of the PHPStan executable based on config and raw filesystem search
     */
    private findBinaryPath() {
        if (this._binaryPath !== null && !fs.existsSync(this._binaryPath)) {
            window.showErrorMessage("[phpstan] Failed to find phpstan, the path " + this._binaryPath + " doesn't exist.");

            this._binaryPath = null;
            return;
        }

        if (this._binaryPath === null) {
            this.findPHPStan();
        }

        if (this._config.enabled && this._binaryPath === null) {
            window.showErrorMessage("[phpstan] Failed to find phpstan, phpstan will be disabled for this session.");
        }
    }

    get diagnosticCollection() {
        return this._diagnosticCollection;
    }

    set enabled(val: boolean) {
        this._config.enabled = val;

        if (this._config.enabled) {
            if (this._binaryPath === null) {
                window.showErrorMessage("[phpstan] Failed to find phpstan, phpstan will be disabled for this session.");
            }
        } else {
            for (let key in this._current) {
                if (this._current[key].killed) {
                    continue;
                }

                this._current[key].kill();
            }

            this._current = {};
            this._numActive = 0;
            this.hideStatusBar();
        }
    }

    set path(val: string) {
        this._binaryPath = val;

        if (this._binaryPath === null) {
            this.findPHPStan();
        }

        if (this._binaryPath === null) {
            window.showErrorMessage("[phpstan] Failed to find phpstan, phpstan will be disabled.");
        }

        if (val !== null && !fs.existsSync(this._binaryPath)) {
            window.showErrorMessage("[phpstan] Failed to find phpstan, the given path doesn't exist.");

            this._binaryPath = null;
        }

        // Check if we have permission to execute this file
        if (val !== null) {
            try {
                fs.accessSync(this._binaryPath, fs.constants.X_OK);
            } catch (exception) {
                window.showErrorMessage("[phpstan] Failed to find phpstan, the given path is not executable.");

                this._binaryPath = null;
            }
        }
    }

    set level(val: string) {
        this._config.level = val;
    }

    set memoryLimit(val: string) {
        this._config.memoryLimit = val;
    }

    set options(val: string[]) {
        this._config.options = val;
    }

    set projectFile(val: string) {
        this._config.projectFile = val;
    }

    set excludeFiles(val: string[]) {
        this._config.excludeFiles = val;
    }
}
